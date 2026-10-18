export type HandoffFile = { path: string; content?: string; diff?: string };
export type HandoffBundle = {
  task: string;
  repo?: string;
  branch?: string;
  constraints?: string[];
  files: HandoffFile[];
  transcript?: Array<{ role: string; text: string }>;
  budgetChars?: number; // default 60000 (~15k tokens) to protect weeklies
};

const DEFAULT_BUDGET = 60000;

export function buildClaudePrompt(bundle: HandoffBundle) {
  const budget = bundle.budgetChars ?? DEFAULT_BUDGET;
  let used = 0;
  const parts: string[] = [];
  parts.push(`TASK:\n${bundle.task}\n`);
  if (bundle.repo) parts.push(`REPO: ${bundle.repo}${bundle.branch ? ` (${bundle.branch})` : ""}\n`);
  if (bundle.constraints?.length) parts.push(`CONSTRAINTS:\n- ${bundle.constraints.join("\n- ")}\n`);

  const fileSections: string[] = [];
  for (const f of bundle.files) {
    const body = f.diff ? `DIFF:\n${f.diff}` : (f.content ?? "");
    const header = `--- FILE: ${f.path} (${body.length} chars) ---\n`;
    if (used + header.length + body.length > budget) {
      const room = Math.max(0, budget - used - header.length - 30);
      fileSections.push(header + body.slice(0, room) + "\n[TRUNCATED]\n");
      used = budget;
      break;
    }
    fileSections.push(header + body + "\n");
    used += header.length + body.length;
  }
  if (fileSections.length) parts.push(`CONTEXT (distilled from OpenCode, ${used}/${budget} chars):\n${fileSections.join("\n")}`);

  if (bundle.transcript?.length) {
    const t = bundle.transcript
      .slice(-10)
      .map((m) => `${m.role.toUpperCase()}: ${m.text.slice(0, 2000)}`)
      .join("\n\n");
    parts.push(`RECENT LABOUR TRANSCRIPT (last 10, truncated):\n${t}\n`);
  }

  parts.push(
    `INSTRUCTIONS FOR CLAUDE (brain only, no labour):\n1. Return a plan, not full code.\n2. Output sections: DECISION, PLAN (numbered steps with files), RISKS, TESTS.\n3. Append a JSON task list in a \`\`\`tasks-json code fence: [{"id":"T1","title":"...","files":["..."],"instructions":"..."}].\n4. Keep output under 3000 tokens.`
  );
  const user = parts.join("\n");
  return {
    system: "You are the brain in an OpenCode labour pipeline. Plan and review only. Labour models execute your task list.",
    user,
    stats: { chars: user.length, files: bundle.files.length, truncated: used >= budget },
  };
}

export type LabourTask = { id: string; title: string; files: string[]; instructions: string };

export function parseClaudePlan(text: string): { tasks: LabourTask[]; raw: string } {
  const m = text.match(/```tasks-json\s*([\s\S]*?)```/);
  if (!m) {
    // Fallback: split on numbered markers anywhere in the text.
    const chunks = text.split(/(?=\b\d{1,2}[.)]\s+)/);
    const tasks: LabourTask[] = [];
    for (const ch of chunks) {
      const pm = ch.match(/^\s*\d{1,2}[.)]\s+([\s\S]{4,300})/);
      if (pm && tasks.length < 20) {
        const title = pm[1].replace(/\s+/g, " ").trim().slice(0, 160);
        tasks.push({ id: `T${tasks.length + 1}`, title, files: [], instructions: title });
      }
    }
    return { tasks, raw: text };
  }
  try {
    const tasks = JSON.parse(m[1]) as LabourTask[];
    return { tasks, raw: text };
  } catch {
    return { tasks: [], raw: text };
  }
}

export function buildOpencodePrompt(task: LabourTask, contextRef: string) {
  return `Execute labour task ${task.id}: ${task.title}\nFiles: ${task.files.join(", ") || "(see repo)"}\nInstructions: ${task.instructions}\nContext ref: ${contextRef}\nReturn: diff + test output only, no architecture discussion.`;
}
