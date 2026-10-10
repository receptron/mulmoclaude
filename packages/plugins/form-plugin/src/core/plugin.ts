import type { ToolContext, ToolResult, ToolPluginCore } from "gui-chat-protocol";
import type {
  FormData,
  FormArgs,
  FormField,
  CheckboxField,
  DateField,
  ExcerptField,
  DropdownField,
  NumberField,
  RadioField,
  TextField,
  TextareaField,
  TimeField,
} from "./types";
import { TOOL_NAME, TOOL_DEFINITION } from "./definition";
import { isInputField } from "./excerpt";

function validateChoiceField(field: FormField): void {
  if (field.type === "radio") {
    if (!Array.isArray(field.choices) || field.choices.length < 2) {
      throw new Error(`Field '${field.id}': radio fields must have at least 2 choices`);
    }
    return;
  }
  if (field.type === "dropdown" || field.type === "checkbox") {
    if (!Array.isArray(field.choices) || field.choices.length < 1) {
      throw new Error(`Field '${field.id}': ${field.type} fields must have at least 1 choice`);
    }
  }
}

function validateCheckboxRange(field: FormField & { type: "checkbox" }): void {
  const { minSelections, maxSelections, choices, id } = field;
  if (minSelections !== undefined && maxSelections !== undefined && minSelections > maxSelections) {
    throw new Error(`Field '${id}': minSelections cannot be greater than maxSelections`);
  }
  if (maxSelections !== undefined && maxSelections > choices.length) {
    throw new Error(`Field '${id}': maxSelections cannot exceed number of choices`);
  }
  // Without this, a form would render but be unsubmittable.
  if (minSelections !== undefined && minSelections > choices.length) {
    throw new Error(`Field '${id}': minSelections cannot exceed number of choices`);
  }
}

function validateRangeField(field: FormField): void {
  if (
    (field.type === "text" || field.type === "textarea") &&
    field.minLength !== undefined &&
    field.maxLength !== undefined &&
    field.minLength > field.maxLength
  ) {
    throw new Error(`Field '${field.id}': minLength cannot be greater than maxLength`);
  }
  if (field.type === "number" && field.min !== undefined && field.max !== undefined && field.min > field.max) {
    throw new Error(`Field '${field.id}': min cannot be greater than max`);
  }
  if (field.type === "date") {
    if (field.minDate !== undefined) requireIsoDate(field.id, "minDate", field.minDate);
    if (field.maxDate !== undefined) requireIsoDate(field.id, "maxDate", field.maxDate);
    if (field.minDate && field.maxDate && field.minDate > field.maxDate) {
      throw new Error(`Field '${field.id}': minDate cannot be after maxDate`);
    }
  }
  if (field.type === "checkbox") validateCheckboxRange(field);
}

// A form arrives from the model, so `defaultValue` is as unchecked as the rest of
// the definition. A default that is not one of the choices, or outside the range
// the same field declares, renders as a field the user cannot leave alone and
// cannot fix — the form looks filled in and submits a value the definition
// forbids. These rules come from `@mulmochat-plugin/form`, the upstream this
// plugin was copied from, which kept them while this copy lost them.
//
// The membership test resolves each choice first: a choice here may be a string
// or `{ label, value? }`, which upstream's `choices.includes()` would refuse.
const choiceValue = (choice: RadioField["choices"][number]): string => (typeof choice === "string" ? choice : (choice.value ?? choice.label));

const choiceLabel = (choice: RadioField["choices"][number]): string => (typeof choice === "string" ? choice : choice.label);

/** The choice the VIEW would select for `wanted`, or -1. It matches a choice by
 *  its value OR its label and takes the first hit (`matchChoice` in View.vue), so
 *  the validator has to ask the same question — a default the view cannot select
 *  is not a default, and one it selects by LABEL submits that choice's value. */
const viewMatchIndex = (choices: RadioField["choices"], wanted: string): number =>
  choices.findIndex((choice) => choiceValue(choice) === wanted || choiceLabel(choice) === wanted);

/** Refuses a default the view would answer with something else: either nothing
 *  matches, or the match is by label while that choice submits a different value.
 *  Without this the form opens with a selection the definition did not ask for. */
function requireSelectableChoice(id: string, choices: RadioField["choices"], wanted: string): void {
  const index = viewMatchIndex(choices, wanted);
  if (index === -1) throw new Error(`Field '${id}': defaultValue '${wanted}' is not in choices`);
  const selected = choices[index];
  if (selected === undefined) throw new Error(`Field '${id}': defaultValue '${wanted}' is not in choices`);
  const submitted = choiceValue(selected);
  if (submitted !== wanted) {
    throw new Error(`Field '${id}': defaultValue '${wanted}' matches the label of a choice that submits '${submitted}'`);
  }
}

/** A date the `date` input can hold: `YYYY-MM-DD`, and a day that exists. A
 *  string the input cannot parse is blanked by the browser, so the form opens
 *  empty while the definition still claims a default. */
function requireIsoDate(id: string, field: string, value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Field '${id}': ${field} must be a date in YYYY-MM-DD form`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!real) throw new Error(`Field '${id}': ${field} '${value}' is not a real date`);
}

/** A time the `time` input can hold: `HH:MM`, optionally with seconds. */
function requireTimeOfDay(id: string, value: string): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value)) {
    throw new Error(`Field '${id}': defaultValue must be a time in HH:MM form`);
  }
}

function validateTextDefault(field: TextField | TextareaField): void {
  const { defaultValue, id, minLength, maxLength } = field;
  if (typeof defaultValue !== "string") throw new Error(`Field '${id}': defaultValue must be a string`);
  if (minLength !== undefined && defaultValue.length < minLength) throw new Error(`Field '${id}': defaultValue length is less than minLength`);
  if (maxLength !== undefined && defaultValue.length > maxLength) throw new Error(`Field '${id}': defaultValue length exceeds maxLength`);
}

function validateChoiceDefault(field: RadioField | DropdownField): void {
  const { defaultValue, id, choices } = field;
  if (typeof defaultValue !== "string") throw new Error(`Field '${id}': defaultValue must be a string`);
  requireSelectableChoice(id, choices, defaultValue);
}

function validateCheckboxDefault(field: CheckboxField): void {
  const { defaultValue, id, choices, minSelections, maxSelections } = field;
  if (!Array.isArray(defaultValue)) throw new Error(`Field '${id}': defaultValue must be an array`);
  // The view ticks a box by index, so a repeat shows as one tick while the count
  // rules see two and the submission emits the choice twice.
  if (new Set(defaultValue).size !== defaultValue.length) {
    throw new Error(`Field '${id}': defaultValue must not repeat a selection`);
  }
  for (const value of defaultValue) {
    if (viewMatchIndex(choices, value) === -1) throw new Error(`Field '${id}': defaultValue contains '${value}' which is not in choices`);
    requireSelectableChoice(id, choices, value);
  }
  if (minSelections !== undefined && defaultValue.length < minSelections)
    throw new Error(`Field '${id}': defaultValue has fewer selections than minSelections`);
  if (maxSelections !== undefined && defaultValue.length > maxSelections) throw new Error(`Field '${id}': defaultValue has more selections than maxSelections`);
}

function validateNumberDefault(field: NumberField): void {
  const { defaultValue, id, min, max } = field;
  if (typeof defaultValue !== "number") throw new Error(`Field '${id}': defaultValue must be a number`);
  if (min !== undefined && defaultValue < min) throw new Error(`Field '${id}': defaultValue is less than min`);
  if (max !== undefined && defaultValue > max) throw new Error(`Field '${id}': defaultValue is greater than max`);
}

function validateDateDefault(field: DateField): void {
  const { defaultValue, id, minDate, maxDate } = field;
  if (typeof defaultValue !== "string") throw new Error(`Field '${id}': defaultValue must be a string (ISO date format)`);
  requireIsoDate(id, "defaultValue", defaultValue);
  if (minDate !== undefined && defaultValue < minDate) throw new Error(`Field '${id}': defaultValue is before minDate`);
  if (maxDate !== undefined && defaultValue > maxDate) throw new Error(`Field '${id}': defaultValue is after maxDate`);
}

function validateTimeDefault(field: TimeField): void {
  if (typeof field.defaultValue !== "string") throw new Error(`Field '${field.id}': defaultValue must be a string`);
  requireTimeOfDay(field.id, field.defaultValue);
}

function validateDefaultValue(field: FormField): void {
  if (field.type === "excerpt" || field.defaultValue === undefined) return;
  if (field.type === "text" || field.type === "textarea") return validateTextDefault(field);
  if (field.type === "radio" || field.type === "dropdown") return validateChoiceDefault(field);
  if (field.type === "checkbox") return validateCheckboxDefault(field);
  if (field.type === "number") return validateNumberDefault(field);
  if (field.type === "date") return validateDateDefault(field);
  return validateTimeDefault(field);
}

/** A highlight the excerpt does not contain renders as no mark at all, so the
 *  user would be asked about a passage without being shown where it is. */
function validateExcerpt(field: ExcerptField): void {
  const { id, text, highlights } = field;
  if (typeof text !== "string" || text.trim() === "") throw new Error(`Field '${id}': excerpt fields must have a non-empty 'text'`);
  if (highlights === undefined) return;
  if (!Array.isArray(highlights)) throw new Error(`Field '${id}': highlights must be an array of strings`);
  highlights.forEach((highlight) => {
    if (typeof highlight !== "string" || highlight === "") throw new Error(`Field '${id}': each highlight must be a non-empty string`);
    if (!text.includes(highlight)) throw new Error(`Field '${id}': highlight '${highlight}' does not appear in text`);
  });
}

/** The types the view can render. A type outside this list renders as nothing at
 *  all, so it is refused here rather than presented as an empty row. */
const FIELD_TYPES = ["text", "textarea", "radio", "dropdown", "checkbox", "date", "time", "number", "excerpt"];

function validateField(field: FormField, index: number, seenIds: Set<string>): void {
  if (!field.id || typeof field.id !== "string") throw new Error(`Field ${index + 1} must have a valid 'id' property`);
  if (!field.type || typeof field.type !== "string") throw new Error(`Field ${index + 1} must have a valid 'type' property`);
  if (!field.label || typeof field.label !== "string") throw new Error(`Field ${index + 1} must have a valid 'label' property`);
  if (!FIELD_TYPES.includes(field.type)) throw new Error(`Field '${field.id}': unknown field type '${field.type}'`);
  if (seenIds.has(field.id)) throw new Error(`Duplicate field ID: '${field.id}'`);
  seenIds.add(field.id);
  if (field.type === "excerpt") return validateExcerpt(field);
  validateChoiceField(field);
  validateRangeField(field);
  validateDefaultValue(field);
}

export const executeForm = async (_context: ToolContext, args: FormArgs): Promise<ToolResult<FormData, FormData>> => {
  try {
    const { title, description, fields } = args;
    if (!fields || !Array.isArray(fields) || fields.length === 0) {
      throw new Error("At least one field is required");
    }
    const seen = new Set<string>();
    fields.forEach((field, i) => validateField(field, i, seen));
    if (!fields.some(isInputField)) throw new Error("At least one field must ask for input; excerpt fields only display text");

    const formData: FormData = { title, description, fields };
    const fieldCount = `${fields.length} field${fields.length > 1 ? "s" : ""}`;
    const titleSuffix = title ? `: ${title}` : "";
    return {
      message: `Form created with ${fieldCount}${titleSuffix}`,
      // `data` is the view's source (also the host's render-gate signal); `jsonData`
      // is what the LLM sees in the tool result. Same payload, two audiences.
      data: formData,
      jsonData: formData,
      instructions:
        "The form has been presented to the user. Wait for the user to fill out and submit it. They will reply with a markdown bullet list of `- {label}: {value}` lines.",
    };
  } catch (error) {
    return {
      message: `Form error: ${error instanceof Error ? error.message : "Unknown error"}`,
      instructions: "Acknowledge that there was an error creating the form and suggest trying again with corrected field definitions.",
    };
  }
};

export const pluginCore: ToolPluginCore<FormData, FormData, FormArgs> = {
  toolDefinition: TOOL_DEFINITION,
  execute: executeForm,
  generatingMessage: "Preparing form...",
  isEnabled: () => true,
};

export { TOOL_NAME, TOOL_DEFINITION };
