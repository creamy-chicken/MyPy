(function () {
    function escapeHtml(value) {
        return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
    }

    function escapeAttribute(value) {
        return escapeHtml(value);
    }

    function formatShortDate(value) {
        if (!value) {
            return "";
        }
        return new Date(value).toLocaleDateString();
    }

    function formatLongDate(value) {
        if (!value) {
            return "";
        }
        return new Date(value).toLocaleString();
    }

    async function jsonApi(path, options = {}, localFileMessage) {
        if (window.location.protocol === "file:") {
            throw new Error(localFileMessage || "Run python3 app.py and open the site over http://localhost.");
        }

        const response = await fetch(path, {
            headers: {
                "Content-Type": "application/json",
            },
            ...options,
        });

        let payload = {};
        try {
            payload = await response.json();
        } catch {
            payload = {};
        }

        if (!response.ok) {
            throw new Error(payload.error || payload.stderr || "Request failed.");
        }

        return payload;
    }

    function createModalController() {
        let modalState = null;
        let modalRoot = null;

        function close(result) {
            if (!modalRoot || !modalState) {
                return;
            }

            const { resolve } = modalState;
            modalState = null;
            modalRoot.classList.add("hidden");
            modalRoot.setAttribute("aria-hidden", "true");
            document.body.classList.remove("modal-open");
            resolve(result);
        }

        function ensureRoot() {
            if (modalRoot) {
                return;
            }

            modalRoot = document.createElement("div");
            modalRoot.className = "app-modal hidden";
            modalRoot.innerHTML = `
                <div class="app-modal-scrim" data-modal-dismiss></div>
                <div class="app-modal-panel" role="dialog" aria-modal="true" aria-labelledby="app-modal-title">
                    <form id="app-modal-form" class="app-modal-form">
                        <div class="app-modal-copy">
                            <h2 id="app-modal-title" class="app-modal-title"></h2>
                            <p id="app-modal-message" class="app-modal-message"></p>
                        </div>
                        <label id="app-modal-field" class="field-group app-modal-field">
                            <span id="app-modal-label"></span>
                            <input id="app-modal-input" class="app-modal-input" name="modal_value" autocomplete="off">
                        </label>
                        <div class="app-modal-actions">
                            <button id="app-modal-cancel" class="button button-muted" type="button">Cancel</button>
                            <button id="app-modal-confirm" class="button" type="submit">OK</button>
                        </div>
                    </form>
                </div>
            `;

            document.body.append(modalRoot);
            modalRoot.querySelector("[data-modal-dismiss]").addEventListener("click", () => close(null));
            modalRoot.querySelector("#app-modal-cancel").addEventListener("click", () => close(null));
            modalRoot.querySelector("#app-modal-form").addEventListener("submit", (event) => {
                event.preventDefault();
                if (!modalState) {
                    return;
                }

                if (modalState.requiresInput) {
                    const inputElement = document.getElementById("app-modal-input");
                    const value = inputElement.value.trim();
                    if (!value) {
                        inputElement.focus();
                        return;
                    }
                    close(value);
                    return;
                }

                close(true);
            });

            document.addEventListener("keydown", (event) => {
                if (event.key === "Escape" && modalState) {
                    close(null);
                }
            });
        }

        function show({
            title,
            message,
            confirmLabel = "OK",
            cancelLabel = "Cancel",
            allowCancel = true,
            inputLabel = "",
            defaultValue = "",
            placeholder = "",
            destructive = false,
        }) {
            ensureRoot();
            close(null);

            const titleElement = document.getElementById("app-modal-title");
            const messageElement = document.getElementById("app-modal-message");
            const fieldElement = document.getElementById("app-modal-field");
            const labelElement = document.getElementById("app-modal-label");
            const inputElement = document.getElementById("app-modal-input");
            const cancelButton = document.getElementById("app-modal-cancel");
            const confirmButton = document.getElementById("app-modal-confirm");

            titleElement.textContent = title;
            messageElement.textContent = message || "";
            messageElement.hidden = !message;
            fieldElement.hidden = !inputLabel;
            labelElement.textContent = inputLabel;
            inputElement.value = defaultValue;
            inputElement.placeholder = placeholder;
            cancelButton.hidden = !allowCancel;
            cancelButton.textContent = cancelLabel;
            confirmButton.textContent = confirmLabel;
            confirmButton.classList.toggle("danger", destructive);

            modalRoot.classList.remove("hidden");
            modalRoot.setAttribute("aria-hidden", "false");
            document.body.classList.add("modal-open");

            return new Promise((resolve) => {
                modalState = {
                    resolve,
                    requiresInput: Boolean(inputLabel),
                };

                const focusTarget = inputLabel ? inputElement : confirmButton;
                window.setTimeout(() => {
                    focusTarget.focus();
                    if (inputLabel) {
                        inputElement.select();
                    }
                }, 0);
            });
        }

        return {
            ensureRoot,
            show,
        };
    }

    window.MyPyShared = {
        createModalController,
        escapeAttribute,
        escapeHtml,
        formatLongDate,
        formatShortDate,
        jsonApi,
    };
})();
