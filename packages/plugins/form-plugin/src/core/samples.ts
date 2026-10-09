import type { ToolSample } from "gui-chat-protocol";

export const samples: ToolSample[] = [
  {
    name: "Contact form",
    args: {
      title: "Contact us",
      description: "We'll get back to you shortly.",
      fields: [
        { id: "name", type: "text", label: "Your name", required: true },
        { id: "email", type: "text", label: "Email", validation: "email", required: true },
        { id: "topic", type: "dropdown", label: "Topic", choices: ["Sales", "Support", "Other"], required: true },
        { id: "message", type: "textarea", label: "Message", rows: 5, maxLength: 500, required: true },
      ],
    },
  },
  {
    name: "Survey",
    args: {
      title: "Quick survey",
      fields: [
        { id: "satisfaction", type: "radio", label: "How satisfied are you?", choices: ["Very", "Somewhat", "Not at all"], required: true },
        { id: "features", type: "checkbox", label: "Which features do you use?", choices: ["Search", "Export", "Sharing"] },
        { id: "since", type: "date", label: "Using since" },
      ],
    },
  },
  {
    name: "Review comments",
    args: {
      title: "Review comments",
      fields: [
        {
          id: "c1_excerpt",
          type: "excerpt",
          label: "Comment 1",
          text: "The new release ships next week. It include several fixes for the importer.",
          highlights: ["It include"],
          description: "Subject-verb agreement.",
        },
        { id: "c1_choice", type: "radio", label: "Comment 1: fix", choices: ["A: It includes", "B: It will include", "Keep as is"], required: true },
        { id: "c1_note", type: "textarea", label: "Comment 1: note", rows: 2 },
      ],
    },
  },
];
