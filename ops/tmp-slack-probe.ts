// Temp probe: is Slack configured, and what does the budget notice return?
import { slackStatus, notifyBudgetExhausted } from "../src/slack.js";

const s = slackStatus();
console.log("SLACK_STATUS=" + JSON.stringify({ ...s, channel: s.channel ? "<set>" : null }));
const r = await notifyBudgetExhausted({
  agentId: "summarizer",
  agentKey: "pmumhg71w::summarizer",
  name: "Summarizer",
  role: "summarizer",
  departmentName: "Engineering",
  projectName: "LiveFinal",
  requiredUsd: 0.01,
  remainingUsd: 0,
  taskTitle: "typecheck-gate probe",
});
console.log("NOTIFY_RESULT=" + JSON.stringify(r));
