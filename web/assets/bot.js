/** The analyst launcher reports activity in words, without decorative animation. */
const STATES = {
  idle: { label: "Ask the analyst", text: "Analyst", hint: "Analyse this estate" },
  thinking: { label: "Thinking…", text: "Thinking…", hint: "Working on your question" },
  analyzing: { label: "Analysing…", text: "Analysing…", hint: "Reading every source" },
  insight: { label: "Found something", text: "Findings", hint: "The analysis has findings" },
  explaining: { label: "Explaining…", text: "Explaining…", hint: "Writing the answer" },
  alert: { label: "Needs attention", text: "Review findings", hint: "Something is over budget or spiking" },
  celebrating: { label: "All clear", text: "All clear", hint: "Nothing worth flagging" },
};

let host = null;
let state = "idle";
let resetTimer = 0;

export function mountBot(container, onClick) {
  host = container;
  host.className = "bot";
  host.dataset.state = "idle";
  host.type = "button";
  host.innerHTML = '<span class="bot-indicator" aria-hidden="true"></span>'
    + '<span class="bot-label">Analyst</span><span class="bot-pip" aria-hidden="true" hidden></span>';
  host.setAttribute("aria-label", STATES.idle.label);
  host.title = STATES.idle.hint;
  host.onclick = onClick;
  return host;
}

/** Temporary verdicts return to idle; ongoing work remains visible until it finishes. */
export function setBotState(next, { hold = 0 } = {}) {
  if (!host || !STATES[next]) return;
  clearTimeout(resetTimer);
  state = next;
  host.dataset.state = next;
  host.setAttribute("aria-label", STATES[next].label);
  host.querySelector(".bot-label").textContent = STATES[next].text;
  host.title = STATES[next].hint;
  if (hold) resetTimer = setTimeout(() => setBotState("idle"), hold);
}

export const botState = () => state;

export function setBotCount(n) {
  if (!host) return;
  const pip = host.querySelector(".bot-pip");
  if (!pip) return;
  pip.textContent = n > 9 ? "9+" : String(n || "");
  pip.hidden = !n;
}
