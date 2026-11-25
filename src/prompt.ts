export const REMINDER_TEXT = `[cccm] Is the task finished?
If it is, run:       cccm report done    --summary "..."
If it failed, run:   cccm report failed  --summary "..."
If you are continuing the task (or background work is still running), first run:
                     cccm report pending --summary "<what remains>"
then continue.`

export function isReminderPrompt(prompt: string): boolean {
  return prompt.startsWith("[cccm] Is the task finished?")
}

export function buildPrompt(userPrompt: string, to: string): string {
  return `${userPrompt}

---
This session reports its status with cccm (claude-code-cloud-monitor).
1. Before starting the task above, run:
     cccm report init --to ${to}
2. When the task is finished, run:   cccm report done --summary "<what you did>"
   If you cannot finish it, run:    cccm report failed --summary "<why>"
   Do not end without running one of them.
`
}
