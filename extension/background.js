// Service worker: única fuente de verdad del cronómetro.
// Vive independientemente del popup para que el tiempo no se pierda al cerrarlo.

const STORAGE_KEY_ACTIVE = "activeSession";
const STORAGE_KEY_SESSIONS = "sessions";

function now() {
  return Date.now();
}

async function getActiveSession() {
  const data = await chrome.storage.local.get(STORAGE_KEY_ACTIVE);
  return data[STORAGE_KEY_ACTIVE] || null;
}

async function setActiveSession(session) {
  await chrome.storage.local.set({ [STORAGE_KEY_ACTIVE]: session });
}

async function appendCompletedSession(session) {
  const data = await chrome.storage.local.get(STORAGE_KEY_SESSIONS);
  const sessions = data[STORAGE_KEY_SESSIONS] || [];
  sessions.push(session);
  await chrome.storage.local.set({ [STORAGE_KEY_SESSIONS]: sessions });
}

function computeElapsedMs(session) {
  if (!session) return 0;
  const base = session.accumulatedMs || 0;
  if (session.status === "running" && session.lastResumeAt) {
    return base + (now() - session.lastResumeAt);
  }
  return base;
}

async function startSession(ticketCode, ticketDesc) {
  const existing = await getActiveSession();
  if (existing) {
    throw new Error("Ya hay una sesión activa. Deténla antes de iniciar otra.");
  }
  const session = {
    ticketCode: ticketCode.trim(),
    ticketDesc: (ticketDesc || "").trim(),
    comment: "",
    status: "running",
    startedAt: now(),
    lastResumeAt: now(),
    accumulatedMs: 0,
  };
  await setActiveSession(session);
  return session;
}

async function pauseSession() {
  const session = await getActiveSession();
  if (!session || session.status !== "running") return session;
  session.accumulatedMs = computeElapsedMs(session);
  session.status = "paused";
  session.lastResumeAt = null;
  await setActiveSession(session);
  return session;
}

async function resumeSession() {
  const session = await getActiveSession();
  if (!session || session.status !== "paused") return session;
  session.status = "running";
  session.lastResumeAt = now();
  await setActiveSession(session);
  return session;
}

async function updateComment(comment) {
  const session = await getActiveSession();
  if (!session) return null;
  session.comment = comment;
  await setActiveSession(session);
  return session;
}

async function stopSession() {
  const session = await getActiveSession();
  if (!session) return null;
  const durationMs = computeElapsedMs(session);
  const completed = {
    id: `${session.ticketCode}-${session.startedAt}`,
    ticketCode: session.ticketCode,
    ticketDesc: session.ticketDesc,
    comment: session.comment || "",
    durationMs,
    startedAt: session.startedAt,
    endedAt: now(),
  };
  await appendCompletedSession(completed);
  await setActiveSession(null);
  return completed;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "GET_STATE": {
          const session = await getActiveSession();
          sendResponse({ ok: true, session, elapsedMs: computeElapsedMs(session) });
          break;
        }
        case "START_SESSION": {
          const session = await startSession(message.ticketCode, message.ticketDesc);
          sendResponse({ ok: true, session, elapsedMs: computeElapsedMs(session) });
          break;
        }
        case "PAUSE_SESSION": {
          const session = await pauseSession();
          sendResponse({ ok: true, session, elapsedMs: computeElapsedMs(session) });
          break;
        }
        case "RESUME_SESSION": {
          const session = await resumeSession();
          sendResponse({ ok: true, session, elapsedMs: computeElapsedMs(session) });
          break;
        }
        case "UPDATE_COMMENT": {
          const session = await updateComment(message.comment);
          sendResponse({ ok: true, session, elapsedMs: computeElapsedMs(session) });
          break;
        }
        case "STOP_SESSION": {
          const completed = await stopSession();
          sendResponse({ ok: true, completed });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Mensaje no reconocido." });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // respuesta asíncrona
});
