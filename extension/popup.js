const formSection = document.getElementById("form-section");
const activeSection = document.getElementById("active-section");

const ticketCodeInput = document.getElementById("ticket-code");
const ticketDescInput = document.getElementById("ticket-desc");
const btnStart = document.getElementById("btn-start");
const formError = document.getElementById("form-error");

const activeCode = document.getElementById("active-code");
const activeDesc = document.getElementById("active-desc");
const timerEl = document.getElementById("timer");
const statusBadge = document.getElementById("status-badge");
const btnPause = document.getElementById("btn-pause");
const btnResume = document.getElementById("btn-resume");
const btnStop = document.getElementById("btn-stop");
const commentInput = document.getElementById("comment");

let tickInterval = null;
let currentSession = null;

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response));
  });
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function computeElapsedMs(session) {
  if (!session) return 0;
  const base = session.accumulatedMs || 0;
  if (session.status === "running" && session.lastResumeAt) {
    return base + (Date.now() - session.lastResumeAt);
  }
  return base;
}

function stopTicking() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

function startTicking() {
  stopTicking();
  tickInterval = setInterval(() => {
    if (currentSession) {
      timerEl.textContent = formatDuration(computeElapsedMs(currentSession));
    }
  }, 1000);
}

function renderActiveSession(session) {
  currentSession = session;

  if (!session) {
    formSection.classList.remove("hidden");
    activeSection.classList.add("hidden");
    stopTicking();
    return;
  }

  formSection.classList.add("hidden");
  activeSection.classList.remove("hidden");

  activeCode.textContent = session.ticketCode;
  activeDesc.textContent = session.ticketDesc || "";
  commentInput.value = session.comment || "";
  timerEl.textContent = formatDuration(computeElapsedMs(session));

  const isRunning = session.status === "running";
  statusBadge.textContent = isRunning ? "En curso" : "Pausado";
  statusBadge.classList.toggle("paused", !isRunning);
  btnPause.classList.toggle("hidden", !isRunning);
  btnResume.classList.toggle("hidden", isRunning);

  if (isRunning) {
    startTicking();
  } else {
    stopTicking();
  }
}

async function loadState() {
  const response = await sendMessage({ type: "GET_STATE" });
  if (response && response.ok) {
    renderActiveSession(response.session);
  }
}

btnStart.addEventListener("click", async () => {
  const ticketCode = ticketCodeInput.value.trim();
  const ticketDesc = ticketDescInput.value.trim();

  if (!ticketCode) {
    formError.textContent = "Ingresa el código del ticket.";
    return;
  }
  formError.textContent = "";

  const response = await sendMessage({
    type: "START_SESSION",
    ticketCode,
    ticketDesc,
  });

  if (response && response.ok) {
    ticketCodeInput.value = "";
    ticketDescInput.value = "";
    renderActiveSession(response.session);
  } else {
    formError.textContent = (response && response.error) || "No se pudo iniciar la sesión.";
  }
});

btnPause.addEventListener("click", async () => {
  const response = await sendMessage({ type: "PAUSE_SESSION" });
  if (response && response.ok) {
    renderActiveSession(response.session);
  }
});

btnResume.addEventListener("click", async () => {
  const response = await sendMessage({ type: "RESUME_SESSION" });
  if (response && response.ok) {
    renderActiveSession(response.session);
  }
});

btnStop.addEventListener("click", async () => {
  await sendMessage({ type: "UPDATE_COMMENT", comment: commentInput.value });
  const response = await sendMessage({ type: "STOP_SESSION" });
  if (response && response.ok) {
    renderActiveSession(null);
  }
});

let commentSaveTimeout = null;
commentInput.addEventListener("input", () => {
  clearTimeout(commentSaveTimeout);
  commentSaveTimeout = setTimeout(() => {
    sendMessage({ type: "UPDATE_COMMENT", comment: commentInput.value });
  }, 400);
});

loadState();
