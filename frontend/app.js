// In production or when served by FastAPI, use relative URLs ("").
// When running frontend separately via Live Server (port 5500), fallback to local backend.
const API = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") && window.location.port !== "8000"
  ? "http://127.0.0.1:8000"
  : "";

// ─── DOM refs ─────────────────────────────────────────────────────────────
const messagesEl = document.getElementById("messages");
const questionInput = document.getElementById("questionInput");
const sendBtn = document.getElementById("sendBtn");
const candidateName = document.getElementById("candidateName");
const candidateSub = document.getElementById("candidateSub");
const candidateAvatar = document.getElementById("candidateAvatar");
const headerSubtitle = document.getElementById("headerSubtitle");

// ─── Suggested questions ──────────────────────────────────────────────────
["s1", "s2", "s3", "s4"].forEach(id => {
  document.getElementById(id).addEventListener("click", () => {
    const text = document.getElementById(id).textContent;
    questionInput.value = text;
    questionInput.dispatchEvent(new Event("input"));
    sendMessage();
  });
});

// ─── Load candidate on startup (retries if still parsing) ────────────────
async function loadCandidate(retries = 8, delay = 1500) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${API}/candidate`);
      if (res.status === 503) {
        // Still parsing — wait and retry
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!res.ok) return;
      const data = await res.json();
      updateCandidateUI(data);
      return;
    } catch (_) {
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function updateCandidateUI(resume) {
  if (!resume?.name) return;

  const initials = resume.name
    .split(" ")
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join("");

  candidateAvatar.textContent = initials;
  candidateName.textContent = resume.name;
  candidateSub.textContent = resume.email || (
    resume.total_experience_years
      ? `${resume.total_experience_years} yrs experience`
      : "Resume loaded"
  );
  headerSubtitle.textContent = `Asking about ${resume.name}`;
}

// ─── Chat (streaming) ─────────────────────────────────────────────────────
async function sendMessage() {
  const question = questionInput.value.trim();
  if (!question) return;

  // Clear welcome screen on first message
  const welcome = messagesEl.querySelector(".welcome-message");
  if (welcome) welcome.remove();

  appendMessage("user", question);
  questionInput.value = "";
  questionInput.style.height = "auto";
  sendBtn.disabled = true;

  // Create the AI bubble immediately (empty, will fill via stream)
  const { row, bubble } = createAiBubble();
  let fullText = "";
  let firstToken = false;

  try {
    const res = await fetch(`${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      bubble.textContent = `⚠️ ${data.detail || "Something went wrong."}`;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") break;

        try {
          const token = JSON.parse(payload);
          if (!firstToken) {
            // Remove typing dots, start showing text
            bubble.classList.add("streaming");
            firstToken = true;
          }
          fullText += token;
          bubble.textContent = fullText;   // plain text while streaming
          scrollToBottom();
        } catch (_) { /* skip malformed chunk */ }
      }
    }

    // Stream complete — render final markdown
    bubble.classList.remove("streaming");
    bubble.classList.add("markdown");
    bubble.innerHTML = DOMPurify.sanitize(marked.parse(fullText));
    scrollToBottom();

  } catch (err) {
    bubble.textContent = "⚠️ Could not reach the server. Make sure the backend is running.";
  } finally {
    sendBtn.disabled = false;
    questionInput.focus();
  }
}

function appendMessage(role, text) {
  const row = document.createElement("div");
  row.className = `message-row ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = role === "user" ? "👤" : "🤖";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (role === "ai") {
    bubble.classList.add("markdown");
    bubble.innerHTML = DOMPurify.sanitize(marked.parse(text));
  } else {
    bubble.textContent = text;
  }

  row.appendChild(avatar);
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  scrollToBottom();
  return row;
}

// Creates an empty AI bubble for streaming into
function createAiBubble() {
  const row = document.createElement("div");
  row.className = "message-row ai";

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = "🤖";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  // Show blinking cursor while waiting for first token
  bubble.innerHTML = '<span class="cursor"></span>';

  row.appendChild(avatar);
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  scrollToBottom();
  return { row, bubble };
}



function scrollToBottom() {
  const wrapper = messagesEl.parentElement;
  wrapper.scrollTop = wrapper.scrollHeight;
}

// ─── Input auto-resize & keyboard shortcuts ───────────────────────────────
questionInput.addEventListener("input", () => {
  questionInput.style.height = "auto";
  questionInput.style.height = Math.min(questionInput.scrollHeight, 140) + "px";
});

questionInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener("click", sendMessage);

// ─── Init ─────────────────────────────────────────────────────────────────
loadCandidate();
