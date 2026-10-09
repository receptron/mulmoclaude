export type FieldType = "text" | "textarea" | "radio" | "dropdown" | "checkbox" | "date" | "time" | "number" | "excerpt";

export interface BaseField {
  id: string;
  type: FieldType;
  label: string;
  description?: string;
  required?: boolean;
  maxLength?: number;
}

export interface TextField extends BaseField {
  type: "text";
  placeholder?: string;
  validation?: "email" | "url" | "phone" | string;
  defaultValue?: string;
  minLength?: number;
  maxLength?: number;
}

export interface TextareaField extends BaseField {
  type: "textarea";
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  rows?: number;
  defaultValue?: string;
}

export interface RadioField extends BaseField {
  type: "radio";
  choices: (string | { label: string; value?: string })[];
  defaultValue?: string;
}

export interface DropdownField extends BaseField {
  type: "dropdown";
  choices: (string | { label: string; value?: string })[];
  searchable?: boolean;
  defaultValue?: string;
}

export interface CheckboxField extends BaseField {
  type: "checkbox";
  choices: (string | { label: string; value?: string })[];
  minSelections?: number;
  maxSelections?: number;
  defaultValue?: string[];
}

export interface DateField extends BaseField {
  type: "date";
  minDate?: string;
  maxDate?: string;
  format?: string;
  defaultValue?: string;
}

export interface TimeField extends BaseField {
  type: "time";
  format?: "12hr" | "24hr";
  defaultValue?: string;
}

export interface NumberField extends BaseField {
  type: "number";
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
}

/** A passage shown to the user, not asked of them: no value, never submitted. */
export interface ExcerptField extends BaseField {
  type: "excerpt";
  text: string;
  highlights?: string[];
}

export type InputField = TextField | TextareaField | RadioField | DropdownField | CheckboxField | DateField | TimeField | NumberField;

export type FormField = InputField | ExcerptField;

export interface FormData {
  title?: string | undefined;
  description?: string | undefined;
  fields: FormField[];
}

export interface FormArgs {
  title?: string;
  description?: string;
  fields: FormField[];
}
