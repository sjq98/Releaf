export const MODULES = [
  { id: "orders", name: "Order Management", icon: "package" },
  { id: "meetings", name: "Meeting Follow-up", icon: "notebook-pen" },
];

export const TODO_FIELDS = [
  { id: "task", name: "Action item", type: "text", required: true, unique: false, options: [] },
  { id: "owner", name: "Owner", type: "text", required: false, unique: false, options: [] },
  { id: "dueDate", name: "Due date", type: "date", required: false, unique: false, options: [] },
  { id: "status", name: "Status", type: "select", required: true, unique: false, options: ["Open", "In progress", "Blocked", "Done"] },
  { id: "acceptance", name: "Acceptance criteria", type: "longtext", required: false, unique: false, options: [] },
];
