// Service worker: única fuente de verdad del cronómetro.
// Vive independientemente del popup para que el tiempo no se pierda al cerrarlo.

const STORAGE_KEY_ACTIVE = "activeSession"; // chrome.storage.local: solo la sesión en curso en ESTE equipo.
const SYNC_META_KEY = "sessionsMeta"; // chrome.storage.sync: historial de tickets, compartido entre equipos.
const SYNC_CHUNK_PREFIX = "sessionsChunk_";
const SYNC_CHUNK_MAX_BYTES = 6000; // margen bajo el límite de 8192 bytes por entrada de chrome.storage.sync.
const LOCAL_OVERFLOW_KEY = "sessionsOverflow"; // respaldo si la cuota de sync se llena.
const HOURLY_ALARM = "hourlyCheck";
const HOURLY_NOTIFICATION = "hourlyCheckNotification";
const HOUR_MS = 60 * 60 * 1000;

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

// El historial de tickets vive en chrome.storage.sync (para verse en todos
// los equipos donde inicies sesión de Chrome con la misma cuenta), repartido
// en varias entradas porque sync limita cada entrada a ~8KB.
async function getSessionChunks() {
  const metaData = await chrome.storage.sync.get(SYNC_META_KEY);
  const meta = metaData[SYNC_META_KEY] || { chunkCount: 0 };
  if (meta.chunkCount === 0) return [];
  const keys = Array.from({ length: meta.chunkCount }, (_, i) => SYNC_CHUNK_PREFIX + i);
  const data = await chrome.storage.sync.get(keys);
  return keys.map((k) => data[k] || []);
}

async function getSyncedSessions() {
  const chunks = await getSessionChunks();
  return chunks.flat();
}

async function getOverflowSessions() {
  const data = await chrome.storage.local.get(LOCAL_OVERFLOW_KEY);
  return data[LOCAL_OVERFLOW_KEY] || [];
}

async function getAllSessions() {
  const [synced, overflow] = await Promise.all([getSyncedSessions(), getOverflowSessions()]);
  return [...synced, ...overflow];
}

async function appendCompletedSession(session) {
  const chunks = await getSessionChunks();
  if (chunks.length === 0) chunks.push([]);

  const lastIndex = chunks.length - 1;
  const candidate = [...chunks[lastIndex], session];
  if (JSON.stringify(candidate).length > SYNC_CHUNK_MAX_BYTES) {
    chunks.push([session]);
  } else {
    chunks[lastIndex] = candidate;
  }

  const toWrite = { [SYNC_META_KEY]: { chunkCount: chunks.length } };
  chunks.forEach((chunk, i) => {
    toWrite[SYNC_CHUNK_PREFIX + i] = chunk;
  });

  try {
    await chrome.storage.sync.set(toWrite);
  } catch (err) {
    // Se llenó la cuota de sincronización (u otro error de red/cuenta):
    // no perdemos el registro, lo guardamos localmente como respaldo.
    console.error("No se pudo sincronizar la sesión, se guarda solo en este equipo:", err);
    const overflow = await getOverflowSessions();
    overflow.push(session);
    await chrome.storage.local.set({ [LOCAL_OVERFLOW_KEY]: overflow });
  }
}

function computeElapsedMs(session) {
  if (!session) return 0;
  const base = session.accumulatedMs || 0;
  if (session.status === "running" && session.lastResumeAt) {
    return base + (now() - session.lastResumeAt);
  }
  return base;
}

// Programa el próximo aviso para cuando se cumpla la siguiente hora de
// tiempo TRABAJADO (no de reloj): si el ticket estuvo en pausa, esas
// pausas no cuentan para el aviso.
async function scheduleHourlyAlarm(session) {
  if (!session || session.status !== "running") return;
  const elapsed = computeElapsedMs(session);
  const msToNext = HOUR_MS - (elapsed % HOUR_MS);
  chrome.alarms.create(HOURLY_ALARM, { delayInMinutes: msToNext / 60000 });
}

async function clearHourlyAlarm() {
  await chrome.alarms.clear(HOURLY_ALARM);
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
  await scheduleHourlyAlarm(session);
  return session;
}

async function pauseSession() {
  const session = await getActiveSession();
  if (!session || session.status !== "running") return session;
  session.accumulatedMs = computeElapsedMs(session);
  session.status = "paused";
  session.lastResumeAt = null;
  await setActiveSession(session);
  await clearHourlyAlarm();
  return session;
}

async function resumeSession() {
  const session = await getActiveSession();
  if (!session || session.status !== "paused") return session;
  session.status = "running";
  session.lastResumeAt = now();
  await setActiveSession(session);
  await scheduleHourlyAlarm(session);
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
  await clearHourlyAlarm();
  await chrome.notifications.clear(HOURLY_NOTIFICATION);
  return completed;
}

// Migración única: versiones anteriores guardaban el historial en
// chrome.storage.local bajo la clave "sessions". Lo movemos a sync para
// no perder tickets ya registrados antes de este cambio.
async function migrateLegacyLocalSessions() {
  const data = await chrome.storage.local.get("sessions");
  const legacy = data.sessions;
  if (!legacy || legacy.length === 0) return;
  for (const session of legacy) {
    await appendCompletedSession(session);
  }
  await chrome.storage.local.remove("sessions");
}
migrateLegacyLocalSessions().catch((err) =>
  console.error("No se pudo migrar el historial anterior:", err)
);

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
        case "GET_SESSIONS": {
          const sessions = await getAllSessions();
          sendResponse({ ok: true, sessions });
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

function showHourlyNotification(session) {
  chrome.notifications.create(HOURLY_NOTIFICATION, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `¿Sigues trabajando en ${session.ticketCode}?`,
    message: session.ticketDesc
      ? `Llevas ${Math.round(computeElapsedMs(session) / HOUR_MS)} hora(s) en: ${session.ticketDesc}`
      : "Llevas una hora registrada en este ticket.",
    priority: 2,
    requireInteraction: true,
    buttons: [{ title: "Sí, continuar" }, { title: "No, cambiar de ticket" }],
  });
}

// Ayuda para probar la notificación manualmente desde la consola del
// service worker (chrome://extensions > "service worker"), sin esperar
// una hora ni escribir el nombre de la alarma a mano:
//   testNotification()
self.testNotification = async () => {
  const session = await getActiveSession();
  if (!session) {
    console.warn("No hay sesión activa. Inicia un ticket desde el popup primero.");
    return "Sin sesión activa";
  }
  showHourlyNotification(session);
  return "Notificación disparada para " + session.ticketCode;
};

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HOURLY_ALARM) return;
  (async () => {
    const session = await getActiveSession();
    if (!session || session.status !== "running") return;

    showHourlyNotification(session);

    // El aviso ya se mostró; programa el siguiente en una hora de trabajo más.
    await scheduleHourlyAlarm(session);
  })();
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId !== HOURLY_NOTIFICATION) return;
  (async () => {
    chrome.notifications.clear(HOURLY_NOTIFICATION);

    if (buttonIndex === 0) {
      // "Sí, continuar": no se hace nada, el cronómetro sigue.
      return;
    }

    // "No, cambiar de ticket": se cierra y guarda la sesión actual.
    await stopSession();

    try {
      await chrome.action.openPopup();
    } catch (_err) {
      chrome.notifications.create(`${HOURLY_NOTIFICATION}-saved`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Sesión guardada",
        message: "Abre la extensión para iniciar el siguiente ticket.",
        priority: 1,
      });
    }
  })();
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === HOURLY_NOTIFICATION) {
    chrome.notifications.clear(HOURLY_NOTIFICATION);
  }
});
