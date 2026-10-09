export const TOOL_NAME = "presentForm";

export const TOOL_DEFINITION = {
  type: "function" as const,
  name: TOOL_NAME,
  description:
    "Create a structured form to collect information from the user. Supports various field types including text input, textarea, multiple choice (radio), dropdown menus, checkboxes, date/time pickers, and number inputs. Each field can have validation rules and help text. An 'excerpt' field shows a passage with highlighted phrases instead of asking for input — put one right before the fields that ask about that passage (e.g. one excerpt + a radio + a textarea per review comment) so the user answers while looking at it.",
  parameters: {
    type: "object" as const,
    properties: {
      title: {
        type: "string",
        description: "Optional title for the form (e.g., 'User Registration')",
      },
      description: {
        type: "string",
        description: "Optional description explaining the purpose of the form",
      },
      fields: {
        type: "array",
        description: "Array of form fields with various types and configurations",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "Unique identifier for the field (e.g., 'email', 'birthdate'). This will be the key in the JSON response. Use descriptive camelCase or snake_case names.",
            },
            type: {
              type: "string",
              enum: ["text", "textarea", "radio", "dropdown", "checkbox", "date", "time", "number", "excerpt"],
              description:
                "Field type: 'text' for short text, 'textarea' for long text, 'radio' for 2-6 choices, 'dropdown' for many choices, 'checkbox' for multiple selections, 'date' for date picker, 'time' for time picker, 'number' for numeric input, 'excerpt' for a read-only passage (uses 'text' and 'highlights'; never submitted)",
            },
            label: {
              type: "string",
              description: "Field label shown to the user",
            },
            description: {
              type: "string",
              description: "Optional help text explaining the field",
            },
            required: {
              type: "boolean",
              description: "Whether the field is required (default: false)",
            },
            placeholder: {
              type: "string",
              description: "Placeholder text for text/textarea fields",
            },
            validation: {
              type: "string",
              description: "For text fields: 'email', 'url', 'phone', or a regex pattern",
            },
            minLength: {
              type: "number",
              description: "Minimum character length for textarea fields",
            },
            maxLength: {
              type: "number",
              description: "Maximum character length for textarea fields",
            },
            rows: {
              type: "number",
              description: "Number of visible rows for textarea (default: 4)",
            },
            choices: {
              type: "array",
              items: { type: "string" },
              description: "Array of choices for radio/dropdown/checkbox fields. Radio should have 2-6 choices, dropdown for 7+ choices.",
            },
            searchable: {
              type: "boolean",
              description: "Make dropdown searchable (for large lists)",
            },
            minSelections: {
              type: "number",
              description: "Minimum number of selections for checkbox fields",
            },
            maxSelections: {
              type: "number",
              description: "Maximum number of selections for checkbox fields",
            },
            minDate: {
              type: "string",
              description: "Minimum date (ISO format: YYYY-MM-DD)",
            },
            maxDate: {
              type: "string",
              description: "Maximum date (ISO format: YYYY-MM-DD)",
            },
            format: {
              type: "string",
              description: "Format for time fields: '12hr' or '24hr'",
            },
            min: {
              type: "number",
              description: "Minimum value for number fields",
            },
            max: {
              type: "number",
              description: "Maximum value for number fields",
            },
            step: {
              type: "number",
              description: "Step increment for number fields",
            },
            text: {
              type: "string",
              description: "For excerpt fields: the passage to show, verbatim. Line breaks are kept.",
            },
            highlights: {
              type: "array",
              items: { type: "string" },
              description:
                "For excerpt fields: phrases inside 'text' to highlight. Each must appear in 'text' exactly; every occurrence is marked, so pick a phrase long enough to be unique.",
            },
            defaultValue: {
              description:
                "Optional default/pre-filled value for the field. Type varies by field: string for text/textarea/radio/dropdown/date/time, number for number fields, array of strings for checkbox fields. For radio/dropdown, must be one of the choices. For checkbox, must be a subset of choices.",
            },
          },
          required: ["id", "type", "label"],
        },
        minItems: 1,
      },
    },
    required: ["fields"],
  },
};

export default TOOL_DEFINITION;
