// ─── EMAIL REMINDER CONTENT ────────────────────────────────
// Duolingo-style motivational task-reminder copy, tailored to how the
// person identifies themselves in Profile (Professional / Student /
// Normal). Everything here is curated text — no AI call, no extra
// cost, sends instantly even on EmailJS's free tier.

const firstName = (name) => (name || "there").trim().split(" ")[0] || "there";

const PROFESSIONAL_LINES = [
  (n, t) => `Hi ${n}, "${t}" is due now — a quick win before your next meeting.`,
  (n, t) => `${n}, keep the momentum going: "${t}" is on the clock.`,
  (n, t) => `Reminder: "${t}" is due. Clearing it now keeps the rest of your day predictable.`,
  (n, t) => `${n}, small tasks like "${t}" compound. Knock it out and move on to the next one.`,
  (n, t) => `"${t}" is due. Ten focused minutes now saves you a scramble later, ${n}.`,
];

const STUDENT_LINES = [
  (n, t) => `Hey ${n}! 📚 "${t}" is due — don't let today be the day you break your streak!`,
  (n, t) => `${n}, future-you will thank present-you for finishing "${t}" right now. 💪`,
  (n, t) => `⏰ "${t}" is calling your name, ${n}. You've got this!`,
  (n, t) => `One task, ${n}: "${t}". Small steps, big grades. Let's go! 🚀`,
  (n, t) => `${n}, quick nudge — "${t}" is due. Exam-week-you says thanks in advance. 😄`,
];

const NORMAL_LINES = [
  (n, t) => `Hey ${n} 👋 just a nudge — "${t}" is due now.`,
  (n, t) => `${n}, "${t}" is on your list and it's time. You've got this!`,
  (n, t) => `⏰ Friendly reminder, ${n}: "${t}" is due.`,
  (n, t) => `${n}, checking in — "${t}" is due now. One less thing after this!`,
];

const BANKS = {
  professional: PROFESSIONAL_LINES,
  student: STUDENT_LINES,
  normal: NORMAL_LINES,
};

const SUBJECTS = {
  professional: (t) => `Task due: ${t}`,
  student: (t) => `⏰ Don't break your streak — ${t}`,
  normal: (t) => `Reminder: ${t}`,
};

// Builds { subject, message } for a reminder email.
// userType: "professional" | "student" | "normal"
// displayName: the person's nickname or Firebase displayName
// task: { title, dueDate, dueTime }
export function buildMotivationEmail(userType, displayName, task) {
  const type = BANKS[userType] ? userType : "normal";
  const bank = BANKS[type];
  const line = bank[Math.floor(Math.random() * bank.length)];
  const name = firstName(displayName);
  return {
    subject: (SUBJECTS[type] || SUBJECTS.normal)(task.title),
    message: line(name, task.title),
  };
}
