const {
    createModalController,
    escapeAttribute,
    escapeHtml,
    formatLongDate,
    formatShortDate,
    jsonApi,
} = window.MyPyShared;

const noteSidebarStateKey = "mypy-note-folder-state";
const modal = createModalController();

const noteState = {
    folders: [],
    currentNote: null,
    selectedFolderId: null,
    selectedNoteId: null,
    mode: "welcome",
    search: {
        mode: "none",
        query: "",
        results: [],
        showAll: false,
    },
};

const noteFolderList = document.getElementById("note-folder-list");
const noteContent = document.getElementById("note-content");
const createNoteFolderButton = document.getElementById("create-note-folder-button");
const noteSearchInput = document.getElementById("note-search-input");
const noteSearchButton = document.getElementById("note-search-button");
const recentNotesButton = document.getElementById("recent-notes-button");
const noteSearchResults = document.getElementById("note-search-results");
const isFileProtocol = window.location.protocol === "file:";

document.addEventListener("DOMContentLoaded", () => {
    modal.ensureRoot();
    bindNoteEvents();
    applyInitialNoteSelectionFromUrl();
    if (isFileProtocol) {
        renderLocalFileMode();
        return;
    }
    loadNotes();
});

function bindNoteEvents() {
    createNoteFolderButton.addEventListener("click", handleCreateNoteFolder);
    noteFolderList.addEventListener("click", handleNoteSidebarClick);
    noteSearchButton.addEventListener("click", handleNoteSearchSubmit);
    recentNotesButton.addEventListener("click", handleRecentNotesClick);
    noteSearchInput.addEventListener("keydown", handleNoteSearchInputKeyDown);
    noteSearchResults.addEventListener("click", handleNoteSearchResultsClick);
}

async function noteApi(path, options = {}) {
    return jsonApi(
        path,
        options,
        "Run python3 app.py and open http://localhost:5000. Direct file access cannot reach the API."
    );
}

function parsePositiveInteger(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        return null;
    }
    return parsed;
}

function applyInitialNoteSelectionFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const noteId = parsePositiveInteger(params.get("noteId"));
    if (noteId) {
        noteState.selectedNoteId = noteId;
    }
}

function syncNoteIdInUrl(noteId) {
    const url = new URL(window.location.href);
    const normalized = parsePositiveInteger(noteId);

    if (normalized) {
        url.searchParams.set("noteId", String(normalized));
    } else {
        url.searchParams.delete("noteId");
    }

    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}

function splitSearchTerms(query) {
    return String(query || "")
        .toLowerCase()
        .match(/[a-z0-9_]+/g) || [];
}

function countMatches(text, term) {
    if (!text || !term) {
        return 0;
    }

    const source = String(text).toLowerCase();
    const needle = String(term).toLowerCase();
    let count = 0;
    let index = 0;

    while (index < source.length) {
        const next = source.indexOf(needle, index);
        if (next === -1) {
            break;
        }
        count += 1;
        index = next + needle.length;
    }

    return count;
}

function compareIsoDateDescending(left, right) {
    return new Date(right || 0).getTime() - new Date(left || 0).getTime();
}

function flattenNoteEntries() {
    const entries = [];

    for (const folder of noteState.folders) {
        for (const note of folder.notes) {
            entries.push({
                id: note.id,
                folder_id: folder.id,
                folder_name: folder.name,
                title: note.title,
                content: note.content || "",
                created_at: note.created_at,
                updated_at: note.updated_at,
            });
        }
    }

    return entries;
}

function scoreNoteEntry(entry, rawQuery) {
    const query = String(rawQuery || "").trim().toLowerCase();
    const terms = splitSearchTerms(query);
    if (!terms.length) {
        return 0;
    }

    const title = String(entry.title || "").toLowerCase();
    const content = String(entry.content || "").toLowerCase();
    let score = 0;

    for (const term of terms) {
        const titleMatches = countMatches(title, term);
        const contentMatches = countMatches(content, term);

        if (titleMatches) {
            score += titleMatches * 22;
            score += 14;
        }
        if (contentMatches) {
            score += contentMatches * 5;
        }
    }

    if (query && title.includes(query)) {
        score += 20;
    }

    return score;
}

function searchNotes(query) {
    return flattenNoteEntries()
        .map((entry) => ({
            ...entry,
            score: scoreNoteEntry(entry, query),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            return compareIsoDateDescending(left.updated_at, right.updated_at);
        });
}

function recentNotes() {
    return flattenNoteEntries().sort((left, right) => compareIsoDateDescending(left.created_at, right.created_at));
}

function refreshNoteSearchResults() {
    if (noteState.search.mode === "query") {
        noteState.search.results = searchNotes(noteState.search.query);
    } else if (noteState.search.mode === "recent") {
        noteState.search.results = recentNotes();
    } else {
        noteState.search.results = [];
    }

    renderNoteSearchResults();
}

function renderNoteSearchResults() {
    if (noteState.search.mode === "none") {
        noteSearchButton.classList.remove("is-active");
        recentNotesButton.classList.remove("is-active");
        noteSearchResults.hidden = true;
        noteSearchResults.innerHTML = "";
        return;
    }

    noteSearchButton.classList.toggle("is-active", noteState.search.mode === "query");
    recentNotesButton.classList.toggle("is-active", noteState.search.mode === "recent");

    const allResults = noteState.search.results;
    const visibleResults = noteState.search.showAll ? allResults : allResults.slice(0, 10);
    const modeLabel = noteState.search.mode === "query" ? `Search: "${escapeHtml(noteState.search.query)}"` : "Recent notes";

    noteSearchResults.hidden = false;
    noteSearchResults.innerHTML = `
        <div class="search-results-header">
            <span>${modeLabel}</span>
            <span>${allResults.length} result${allResults.length === 1 ? "" : "s"}</span>
        </div>
        ${
            visibleResults.length
                ? visibleResults
                      .map(
                          (entry) => `
                            <article class="search-result-item">
                                <div class="search-result-main">
                                    <button class="button search-result-title" data-action="search-select-note" data-note-id="${entry.id}" data-folder-id="${entry.folder_id}">
                                        ${escapeHtml(entry.title)}
                                    </button>
                                    <div class="search-result-meta">
                                        <span>${escapeHtml(entry.folder_name)}</span>
                                        <span>Created ${formatShortDate(entry.created_at)}</span>
                                    </div>
                                </div>
                                <span class="search-result-score">
                                    ${noteState.search.mode === "query" ? `${entry.score} pts` : formatShortDate(entry.created_at)}
                                </span>
                            </article>
                        `
                      )
                      .join("")
                : `<div class="search-empty">No matching notes found.</div>`
        }
        ${
            allResults.length > 10
                ? `
                    <button class="button small" data-action="toggle-search-view" type="button">
                        ${noteState.search.showAll ? "Show Top 10" : "View Remaining Results"}
                    </button>
                `
                : ""
        }
    `;
}

function renderLocalFileMode() {
    createNoteFolderButton.disabled = true;
    noteSearchInput.disabled = true;
    noteSearchButton.disabled = true;
    recentNotesButton.disabled = true;
    noteSearchResults.hidden = true;
    noteFolderList.innerHTML = `
        <div class="notes-empty">
            <h2>Server Required</h2>
            <p>The notes layout can render locally, but saving notes still needs the backend server.</p>
        </div>
    `;
    noteContent.innerHTML = `
        <section class="notes-empty">
            <h2>Open Notes Through HTTP</h2>
            <p>Run <strong>python3 app.py</strong> in this folder, then open <strong>http://localhost:5000/notes-app</strong>.</p>
            <p>Opening <strong>notes.html</strong> directly will not connect to the database routes.</p>
        </section>
    `;
}

function promptForFolderName(title, defaultValue = "") {
    return modal.show({
        title,
        message: "Use a short name that will be easy to scan in the sidebar.",
        confirmLabel: defaultValue ? "Save" : "Create",
        inputLabel: "Folder name",
        defaultValue,
        placeholder: "Examples: Ideas, References, Daily",
    });
}

function confirmAction(title, message) {
    return modal.show({
        title,
        message,
        confirmLabel: "Delete",
        cancelLabel: "Keep",
        destructive: true,
    });
}

function showError(message) {
    return modal.show({
        title: "Request Failed",
        message,
        confirmLabel: "Close",
        allowCancel: false,
    });
}

function getNoteExpandedState() {
    try {
        return JSON.parse(localStorage.getItem(noteSidebarStateKey) || "{}");
    } catch {
        return {};
    }
}

function setNoteExpandedState(nextState) {
    localStorage.setItem(noteSidebarStateKey, JSON.stringify(nextState));
}

function isNoteFolderExpanded(folderId) {
    const expandedState = getNoteExpandedState();
    return expandedState[String(folderId)] !== false;
}

function toggleNoteFolder(folderId) {
    const expandedState = getNoteExpandedState();
    expandedState[String(folderId)] = !isNoteFolderExpanded(folderId);
    setNoteExpandedState(expandedState);
    renderNoteSidebar();
}

function findFirstNoteId(folders) {
    for (const folder of folders) {
        if (folder.notes.length > 0) {
            return folder.notes[0].id;
        }
    }
    return null;
}

async function loadNotes() {
    try {
        const payload = await noteApi("/notes");
        noteState.folders = Array.isArray(payload.folders) ? payload.folders : [];

        const noteStillExists = noteState.folders.some((folder) =>
            folder.notes.some((note) => note.id === noteState.selectedNoteId)
        );
        const folderStillExists = noteState.folders.some((folder) => folder.id === noteState.selectedFolderId);

        if (!noteStillExists) {
            noteState.selectedNoteId = findFirstNoteId(noteState.folders);
        }

        if (!folderStillExists) {
            noteState.selectedFolderId = noteState.folders[0]?.id || null;
        }

        refreshNoteSearchResults();

        if (noteState.mode === "create-note" && !noteState.selectedFolderId) {
            noteState.mode = "welcome";
        } else if (noteState.selectedNoteId) {
            noteState.mode = "view-note";
            await loadNote(noteState.selectedNoteId);
        } else {
            noteState.currentNote = null;
            noteState.mode = "welcome";
            syncNoteIdInUrl(null);
            renderNoteContent();
        }

        renderNoteSidebar();
    } catch (error) {
        renderNoteError(error.message);
    }
}

async function loadNote(noteId) {
    try {
        const payload = await noteApi(`/notes/${noteId}`);
        noteState.currentNote = payload.note;
        noteState.selectedNoteId = payload.note.id;
        noteState.selectedFolderId = payload.note.folder_id;
        noteState.mode = "view-note";
        syncNoteIdInUrl(noteState.selectedNoteId);
        renderNoteContent();
        renderNoteSidebar();
    } catch (error) {
        renderNoteError(error.message);
    }
}

function renderNoteSidebar() {
    if (noteState.folders.length === 0) {
        noteFolderList.innerHTML = `
            <div class="notes-empty">
                <h2>No Note Folders</h2>
                <p>Create a note folder to start writing.</p>
            </div>
        `;
        return;
    }

    noteFolderList.innerHTML = noteState.folders
        .map((folder) => {
            const expanded = isNoteFolderExpanded(folder.id);
            return `
                <section class="note-folder-group">
                    <div class="note-folder-header">
                        <button class="button small" data-action="toggle-folder" data-folder-id="${folder.id}">
                            ${expanded ? "[-]" : "[+]"}
                        </button>
                        <button class="button folder-label-button ${noteState.selectedFolderId === folder.id ? "active" : ""}" data-action="select-folder" data-folder-id="${folder.id}">
                            ${escapeHtml(folder.name)}
                        </button>
                        <div class="note-folder-actions">
                            <button class="button small" data-action="new-note" data-folder-id="${folder.id}">New Note</button>
                            <button class="button small" data-action="rename-folder" data-folder-id="${folder.id}">Rename</button>
                            <button class="button small" data-action="delete-folder" data-folder-id="${folder.id}">Delete</button>
                        </div>
                    </div>
                    ${
                        expanded
                            ? `
                                <div class="note-folder-body">
                                    ${
                                        folder.notes.length
                                            ? folder.notes
                                                  .map(
                                                      (note) => `
                                                        <div class="note-item ${noteState.selectedNoteId === note.id ? "active" : ""}">
                                                            <button class="button note-link-button ${noteState.selectedNoteId === note.id ? "active" : ""}" data-action="select-note" data-note-id="${note.id}" data-folder-id="${folder.id}">
                                                                ${escapeHtml(note.title)}
                                                            </button>
                                                            <span>${formatShortDate(note.updated_at)}</span>
                                                        </div>
                                                    `
                                                  )
                                                  .join("")
                                            : `<div>No notes in this folder.</div>`
                                    }
                                </div>
                            `
                            : ""
                    }
                </section>
            `;
        })
        .join("");
}

function renderNoteContent() {
    if (noteState.mode === "create-note") {
        const folder = noteState.folders.find((item) => item.id === noteState.selectedFolderId);
        noteContent.innerHTML = `
            <section class="notes-editor">
                <h2>Create Note</h2>
                <p>Store a note in <strong>${escapeHtml(folder?.name || "Selected Folder")}</strong>.</p>
                <form id="note-editor-form">
                    <label class="field-group">
                        <span>Title</span>
                        <input name="title" required>
                    </label>
                    <label class="field-group">
                        <span>Content</span>
                        <textarea class="note-content-area" name="content" rows="18"></textarea>
                    </label>
                    <div class="note-editor-actions">
                        <button class="button" type="submit">Save Note</button>
                        <button id="cancel-note-button" class="button" type="button">Cancel</button>
                    </div>
                </form>
            </section>
        `;
        document.getElementById("note-editor-form").addEventListener("submit", handleCreateNoteSubmit);
        document.getElementById("cancel-note-button").addEventListener("click", cancelNoteMode);
        return;
    }

    if (noteState.mode === "view-note" && noteState.currentNote) {
        noteContent.innerHTML = `
            <section class="notes-editor">
                <h2>${escapeHtml(noteState.currentNote.title)}</h2>
                <form id="note-editor-form">
                    <div class="note-meta">
                        <span>Created: ${formatLongDate(noteState.currentNote.created_at)}</span>
                        <span>Updated: ${formatLongDate(noteState.currentNote.updated_at)}</span>
                    </div>
                    <label class="field-group">
                        <span>Title</span>
                        <input name="title" value="${escapeAttribute(noteState.currentNote.title)}" required>
                    </label>
                    <label class="field-group">
                        <span>Folder</span>
                        <select name="folder_id">
                            ${noteState.folders
                                .map(
                                    (folder) => `
                                        <option value="${folder.id}" ${folder.id === noteState.currentNote.folder_id ? "selected" : ""}>
                                            ${escapeHtml(folder.name)}
                                        </option>
                                    `
                                )
                                .join("")}
                        </select>
                    </label>
                    <label class="field-group">
                        <span>Content</span>
                        <textarea class="note-content-area" name="content" rows="18">${escapeHtml(noteState.currentNote.content)}</textarea>
                    </label>
                    <div class="note-editor-actions">
                        <button class="button" type="submit">Save</button>
                        <button id="delete-note-button" class="button" type="button">Delete Note</button>
                    </div>
                </form>
            </section>
        `;
        document.getElementById("note-editor-form").addEventListener("submit", handleSaveNoteSubmit);
        document.getElementById("delete-note-button").addEventListener("click", handleDeleteNote);
        return;
    }

    const selectedFolder = noteState.folders.find((folder) => folder.id === noteState.selectedFolderId);
    noteContent.innerHTML = `
        <section class="notes-empty">
            <h2>${selectedFolder ? escapeHtml(selectedFolder.name) : "Notes"}</h2>
            <p>${selectedFolder ? "This folder does not contain any notes yet." : "Create a note folder to begin."}</p>
            ${
                selectedFolder
                    ? `<button id="empty-create-note-button" class="button">Create Note</button>`
                    : `<button id="empty-create-note-folder-button" class="button">Create Folder</button>`
            }
        </section>
    `;

    if (selectedFolder) {
        document.getElementById("empty-create-note-button").addEventListener("click", () => {
            enterCreateNoteMode(selectedFolder.id);
        });
    } else {
        document.getElementById("empty-create-note-folder-button").addEventListener("click", handleCreateNoteFolder);
    }
}

function renderNoteError(message) {
    noteContent.innerHTML = `
        <section class="notes-empty">
            <h2>Request Failed</h2>
            <p>${escapeHtml(message)}</p>
        </section>
    `;
}

function enterCreateNoteMode(folderId) {
    noteState.selectedFolderId = Number(folderId);
    noteState.mode = "create-note";
    renderNoteSidebar();
    renderNoteContent();
}

function cancelNoteMode() {
    if (noteState.selectedNoteId) {
        noteState.mode = "view-note";
    } else {
        noteState.mode = "welcome";
    }
    renderNoteContent();
}

function handleNoteSearchSubmit() {
    const query = noteSearchInput.value.trim();

    if (!query) {
        noteState.search = {
            mode: "none",
            query: "",
            results: [],
            showAll: false,
        };
        renderNoteSearchResults();
        return;
    }

    noteState.search = {
        mode: "query",
        query,
        results: [],
        showAll: false,
    };
    refreshNoteSearchResults();
}

function handleRecentNotesClick() {
    noteState.search = {
        mode: "recent",
        query: "",
        results: [],
        showAll: false,
    };
    refreshNoteSearchResults();
}

function handleNoteSearchInputKeyDown(event) {
    if (event.key === "Enter") {
        event.preventDefault();
        handleNoteSearchSubmit();
        return;
    }

    if (event.key === "Escape" && noteState.search.mode !== "none") {
        event.preventDefault();
        noteSearchInput.value = "";
        noteState.search = {
            mode: "none",
            query: "",
            results: [],
            showAll: false,
        };
        renderNoteSearchResults();
    }
}

async function handleNoteSearchResultsClick(event) {
    const actionTarget = event.target.closest("[data-action]");
    if (!actionTarget) {
        return;
    }

    const { action, folderId, noteId } = actionTarget.dataset;

    if (action === "toggle-search-view") {
        noteState.search.showAll = !noteState.search.showAll;
        renderNoteSearchResults();
        return;
    }

    if (action === "search-select-note") {
        noteState.selectedFolderId = Number(folderId);
        await loadNote(Number(noteId));
    }
}

async function handleCreateNoteFolder() {
    const name = await promptForFolderName("Create Folder");
    if (!name) {
        return;
    }

    try {
        const payload = await noteApi("/note-folders", {
            method: "POST",
            body: JSON.stringify({ name }),
        });
        noteState.selectedFolderId = payload.folder.id;
        const expandedState = getNoteExpandedState();
        expandedState[String(payload.folder.id)] = true;
        setNoteExpandedState(expandedState);
        await loadNotes();
    } catch (error) {
        await showError(error.message);
    }
}

async function handleNoteSidebarClick(event) {
    const actionTarget = event.target.closest("[data-action]");
    if (!actionTarget) {
        return;
    }

    const { action, folderId, noteId } = actionTarget.dataset;

    if (action === "toggle-folder") {
        toggleNoteFolder(Number(folderId));
        return;
    }

    if (action === "select-folder") {
        noteState.selectedFolderId = Number(folderId);
        noteState.selectedNoteId = null;
        noteState.currentNote = null;
        noteState.mode = "welcome";
        syncNoteIdInUrl(null);
        renderNoteSidebar();
        renderNoteContent();
        return;
    }

    if (action === "new-note") {
        enterCreateNoteMode(Number(folderId));
        return;
    }

    if (action === "rename-folder") {
        const folder = noteState.folders.find((item) => item.id === Number(folderId));
        const nextName = await promptForFolderName("Rename Folder", folder?.name || "");
        if (!nextName) {
            return;
        }

        try {
            await noteApi(`/note-folders/${folderId}`, {
                method: "PUT",
                body: JSON.stringify({ name: nextName }),
            });
            await loadNotes();
        } catch (error) {
            await showError(error.message);
        }
        return;
    }

    if (action === "delete-folder") {
        const confirmed = await confirmAction("Delete Folder", "Delete this folder and every note inside it?");
        if (!confirmed) {
            return;
        }

        try {
            await noteApi(`/note-folders/${folderId}`, { method: "DELETE" });
            if (Number(folderId) === noteState.selectedFolderId) {
                noteState.selectedFolderId = null;
                noteState.selectedNoteId = null;
                noteState.currentNote = null;
                noteState.mode = "welcome";
            }
            await loadNotes();
        } catch (error) {
            await showError(error.message);
        }
        return;
    }

    if (action === "select-note") {
        noteState.selectedFolderId = Number(folderId);
        await loadNote(Number(noteId));
    }
}

async function handleCreateNoteSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    try {
        const payload = await noteApi("/notes", {
            method: "POST",
            body: JSON.stringify({
                folder_id: noteState.selectedFolderId,
                title: formData.get("title"),
                content: formData.get("content"),
            }),
        });
        noteState.selectedNoteId = payload.note.id;
        noteState.currentNote = payload.note;
        noteState.mode = "view-note";
        await loadNotes();
    } catch (error) {
        await showError(error.message);
    }
}

async function handleSaveNoteSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    try {
        const payload = await noteApi(`/notes/${noteState.currentNote.id}`, {
            method: "PUT",
            body: JSON.stringify({
                folder_id: Number(formData.get("folder_id")),
                title: formData.get("title"),
                content: formData.get("content"),
            }),
        });
        noteState.currentNote = payload.note;
        noteState.selectedFolderId = payload.note.folder_id;
        noteState.selectedNoteId = payload.note.id;
        await loadNotes();
    } catch (error) {
        await showError(error.message);
    }
}

async function handleDeleteNote() {
    if (!noteState.currentNote) {
        return;
    }

    const confirmed = await confirmAction("Delete Note", "Delete this note?");
    if (!confirmed) {
        return;
    }

    try {
        await noteApi(`/notes/${noteState.currentNote.id}`, { method: "DELETE" });
        noteState.currentNote = null;
        noteState.selectedNoteId = null;
        noteState.mode = "welcome";
        await loadNotes();
    } catch (error) {
        await showError(error.message);
    }
}
