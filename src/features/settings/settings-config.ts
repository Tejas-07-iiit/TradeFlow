export const settingsGroups = [
  {
    title: "Profile",
    description: "Identity and workspace metadata.",
    rows: ["Display name", "Avatar", "Primary email"],
  },
  {
    title: "Appearance",
    description: "Terminal density and visual preferences.",
    rows: ["Compact tables", "Chart grid opacity", "Theme: institutional dark"],
  },
  {
    title: "Notifications",
    description: "Signal, risk, and execution alerts.",
    rows: ["Signal confidence threshold", "Risk warnings", "Daily research digest"],
  },
  {
    title: "Trading Preferences",
    description: "Defaults for simulated order entry.",
    rows: ["Default symbol", "Default order type", "Confirmation prompts"],
  },
  {
    title: "Risk Settings",
    description: "Guardrails for paper portfolio simulation.",
    rows: ["Max risk per trade", "Max leverage", "Daily loss limit"],
  },
  {
    title: "API Integrations",
    description: "Reserved for future exchange and data-provider keys.",
    rows: ["Binance public data", "Private API keys disabled", "Webhook placeholders"],
  },
];
