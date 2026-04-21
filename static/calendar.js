const {
    escapeHtml,
    jsonApi,
} = window.MyPyShared;

const monthLabel = document.getElementById("calendar-month-label");
const prevButton = document.getElementById("calendar-prev-button");
const nextButton = document.getElementById("calendar-next-button");
const todayButton = document.getElementById("calendar-today-button");
const calendarGrid = document.getElementById("calendar-grid");
const isFileProtocol = window.location.protocol === "file:";

const calendarState = {
    monthCursor: startOfMonth(new Date()),
    blocks: [],
    notes: [],
};

document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    if (isFileProtocol) {
        renderError(
            "Run python3 app.py and open http://localhost:5000 so the calendar can load notes and code blocks."
        );
        return;
    }
    loadCalendarData();
});

function bindEvents() {
    prevButton.addEventListener("click", () => {
        calendarState.monthCursor = new Date(
            calendarState.monthCursor.getFullYear(),
            calendarState.monthCursor.getMonth() - 1,
            1
        );
        renderCalendar();
    });

    nextButton.addEventListener("click", () => {
        calendarState.monthCursor = new Date(
            calendarState.monthCursor.getFullYear(),
            calendarState.monthCursor.getMonth() + 1,
            1
        );
        renderCalendar();
    });

    todayButton.addEventListener("click", () => {
        calendarState.monthCursor = startOfMonth(new Date());
        renderCalendar();
    });
}

async function api(path, options = {}) {
    return jsonApi(
        path,
        options,
        "Run python3 app.py and open http://localhost:5000 so the calendar can reach API routes."
    );
}

function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

function toDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function parseDateKey(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    return toDateKey(date);
}

function flattenNotes(folders) {
    if (!Array.isArray(folders)) {
        return [];
    }

    const notes = [];
    for (const folder of folders) {
        for (const note of folder.notes || []) {
            notes.push({
                id: note.id,
                title: note.title,
                created_at: note.created_at,
            });
        }
    }

    return notes;
}

async function loadCalendarData() {
    try {
        const [blocksPayload, notesPayload] = await Promise.all([
            api("/blocks"),
            api("/notes"),
        ]);

        calendarState.blocks = Array.isArray(blocksPayload.blocks) ? blocksPayload.blocks : [];
        calendarState.notes = flattenNotes(notesPayload.folders);
        renderCalendar();
    } catch (error) {
        renderError(error.message);
    }
}

function buildDayItems() {
    const byDate = {};

    for (const note of calendarState.notes) {
        const key = parseDateKey(note.created_at);
        if (!key) {
            continue;
        }
        if (!byDate[key]) {
            byDate[key] = [];
        }
        byDate[key].push({
            type: "note",
            id: note.id,
            label: note.title || "Untitled note",
        });
    }

    for (const block of calendarState.blocks) {
        const key = parseDateKey(block.created_at);
        if (!key) {
            continue;
        }
        if (!byDate[key]) {
            byDate[key] = [];
        }
        byDate[key].push({
            type: "code",
            id: block.id,
            label: block.name || "Untitled code block",
        });
    }

    return byDate;
}

function renderCalendar() {
    const monthDate = calendarState.monthCursor;
    const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    const firstWeekday = monthStart.getDay();
    const daysInMonth = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
    const cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
    const byDate = buildDayItems();

    monthLabel.textContent = monthDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });

    const cells = [];
    for (let index = 0; index < cellCount; index += 1) {
        const dayNumber = index - firstWeekday + 1;
        if (dayNumber < 1 || dayNumber > daysInMonth) {
            cells.push(`<div class="calendar-day calendar-day-empty" aria-hidden="true"></div>`);
            continue;
        }

        const currentDate = new Date(monthDate.getFullYear(), monthDate.getMonth(), dayNumber);
        const dateKey = toDateKey(currentDate);
        const items = byDate[dateKey] || [];

        cells.push(`
            <article class="calendar-day">
                <header class="calendar-day-number">${dayNumber}</header>
                <div class="calendar-items">
                    ${
                        items.length
                            ? items.map((item) => renderDayItem(item)).join("")
                            : `<span class="calendar-empty">No items</span>`
                    }
                </div>
            </article>
        `);
    }

    calendarGrid.innerHTML = cells.join("");
}

function renderDayItem(item) {
    if (item.type === "note") {
        return `
            <a class="calendar-item-link calendar-item-note" href="notes.html?noteId=${item.id}">
                ${escapeHtml(item.label)}
            </a>
        `;
    }

    return `
        <a class="calendar-item-link calendar-item-code" href="index.html?blockId=${item.id}">
            ${escapeHtml(item.label)}
        </a>
    `;
}

function renderError(message) {
    monthLabel.textContent = "Calendar";
    calendarGrid.innerHTML = `
        <section class="empty-state">
            <h2>Unable To Load Calendar</h2>
            <p>${escapeHtml(message)}</p>
        </section>
    `;
}
