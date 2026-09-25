"use client";

import { useState, type FormEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  FolderOpen,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import type { Article, Folder, MonitorAction } from "@/lib/types";
import { MAX_FOLDER_NAME_LENGTH } from "@/lib/folders";

export function FolderManager({
  folders,
  selectedFolder,
  busy,
  onSelect,
  onAction,
}: {
  folders: Folder[];
  selectedFolder: Folder | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onAction: (action: MonitorAction) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedName, setEditedName] = useState("");
  const active = folders.filter((folder) => !folder.archived);
  const archived = folders.filter((folder) => folder.archived);

  async function createFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    if (await onAction({ action: "createFolder", name })) setName("");
  }

  async function renameFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !editingId || !editedName.trim()) return;
    if (
      await onAction({
        action: "renameFolder",
        id: editingId,
        name: editedName,
      })
    )
      setEditingId(null);
  }

  function folderButton(folder: Folder) {
    return (
      <button
        className={`folder-choice ${selectedFolder?.id === folder.id ? "is-selected" : ""}`}
        key={folder.id}
        type="button"
        aria-pressed={selectedFolder?.id === folder.id}
        onClick={() => {
          setEditingId(null);
          onSelect(folder.id);
        }}
      >
        <FolderOpen size={16} />
        <span>{folder.name}</span>
        <span className="folder-count">{folder.articleCount}</span>
      </button>
    );
  }

  return (
    <section className="folder-manager" aria-label="Gérer les dossiers">
      <form
        className="folder-create"
        onSubmit={(event) => void createFolder(event)}
      >
        <label htmlFor="new-folder-name">Nouveau dossier</label>
        <div className="folder-form-row">
          <input
            id="new-folder-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_FOLDER_NAME_LENGTH}
            placeholder="Ex. Drones et robotique"
            required
            disabled={busy}
          />
          <button
            className="button button-primary"
            type="submit"
            disabled={busy || !name.trim()}
          >
            <Plus size={16} /> Créer
          </button>
        </div>
      </form>

      {folders.length === 0 ? (
        <div className="folder-library-empty">
          <FolderOpen size={25} />
          <div>
            <h2>Votre premier dossier commence ici.</h2>
            <p>
              Créez un dossier, puis utilisez « Classer » sur les publications
              du flux.
            </p>
          </div>
        </div>
      ) : (
        <>
          {active.length > 0 ? (
            <div
              className="folder-choices"
              role="group"
              aria-label="Dossiers actifs"
            >
              {active.map(folderButton)}
            </div>
          ) : (
            <p className="folder-help">
              Tous vos dossiers sont archivés. Vous pouvez les restaurer ou
              créer un nouveau dossier.
            </p>
          )}
          {archived.length > 0 && (
            <details className="folder-archives">
              <summary>
                <Archive size={14} /> Dossiers archivés ({archived.length})
              </summary>
              <div
                className="folder-choices"
                role="group"
                aria-label="Dossiers archivés"
              >
                {archived.map(folderButton)}
              </div>
            </details>
          )}
          {selectedFolder && (
            <div className="folder-selected">
              {editingId === selectedFolder.id ? (
                <form
                  className="folder-rename"
                  onSubmit={(event) => void renameFolder(event)}
                >
                  <label className="sr-only" htmlFor="rename-folder-name">
                    Nom du dossier
                  </label>
                  <input
                    id="rename-folder-name"
                    value={editedName}
                    onChange={(event) => setEditedName(event.target.value)}
                    maxLength={MAX_FOLDER_NAME_LENGTH}
                    required
                    disabled={busy}
                    autoFocus
                  />
                  <button
                    className="button button-secondary"
                    type="submit"
                    disabled={busy || !editedName.trim()}
                  >
                    <Check size={15} /> Enregistrer
                  </button>
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => setEditingId(null)}
                  >
                    <X size={15} /> Annuler
                  </button>
                </form>
              ) : (
                <>
                  <div className="folder-selected-name">
                    <FolderOpen size={18} />
                    <strong>{selectedFolder.name}</strong>
                    {selectedFolder.archived && (
                      <span className="folder-archived-label">Archivé</span>
                    )}
                  </div>
                  <div className="folder-management-actions">
                    <button
                      className="article-action"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(selectedFolder.id);
                        setEditedName(selectedFolder.name);
                      }}
                    >
                      <Pencil size={14} /> Renommer
                    </button>
                    <button
                      className="article-action"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void onAction({
                          action: "setFolderArchived",
                          id: selectedFolder.id,
                          value: !selectedFolder.archived,
                        })
                      }
                    >
                      {selectedFolder.archived ? (
                        <ArchiveRestore size={15} />
                      ) : (
                        <Archive size={15} />
                      )}
                      {selectedFolder.archived ? "Restaurer" : "Archiver"}
                    </button>
                  </div>
                </>
              )}
              {selectedFolder.archived && (
                <p className="folder-help">
                  Ce dossier conserve ses publications. Restaurez-le pour en
                  ajouter.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function ArticleFolders({
  article,
  folders,
  busy,
  onAction,
  onOpenFolders,
}: {
  article: Article;
  folders: Folder[];
  busy: boolean;
  onAction: (action: MonitorAction) => void;
  onOpenFolders: (id?: string) => void;
}) {
  const assigned = folders.filter((folder) =>
    article.folderIds.includes(folder.id),
  );
  const available = folders.filter(
    (folder) => !folder.archived || article.folderIds.includes(folder.id),
  );
  return (
    <div className="article-folder-controls">
      {assigned.length > 0 && (
        <div
          className="article-folder-tags"
          aria-label="Dossiers de cette publication"
        >
          {assigned.slice(0, 2).map((folder) => (
            <button
              type="button"
              key={folder.id}
              onClick={() => onOpenFolders(folder.id)}
            >
              <FolderOpen size={12} /> {folder.name}
              {folder.archived ? " · archivé" : ""}
            </button>
          ))}
          {assigned.length > 2 && (
            <span
              title={assigned
                .slice(2)
                .map((folder) => folder.name)
                .join(", ")}
            >
              + {assigned.length - 2}
            </span>
          )}
        </div>
      )}
      <details className="article-folder-picker">
        <summary>
          <FolderOpen size={14} /> Classer
          {assigned.length > 0 ? ` (${assigned.length})` : ""}
        </summary>
        <div className="folder-picker-panel">
          {available.length > 0 && (
            <fieldset disabled={busy}>
              <legend className="sr-only">Dossiers pour {article.title}</legend>
              {available.map((folder) => (
                <label key={folder.id}>
                  <input
                    type="checkbox"
                    checked={article.folderIds.includes(folder.id)}
                    onChange={(event) =>
                      onAction({
                        action: "setArticleFolder",
                        id: article.id,
                        folderId: folder.id,
                        value: event.target.checked,
                      })
                    }
                  />
                  <span>
                    {folder.name}
                    {folder.archived && (
                      <small>Archivé — retrait possible</small>
                    )}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {!folders.some((folder) => !folder.archived) && (
            <p>Aucun dossier actif pour classer cette publication.</p>
          )}
          <button
            className="folder-manage-link"
            type="button"
            onClick={() => onOpenFolders()}
          >
            <Plus size={13} />{" "}
            {folders.length ? "Gérer les dossiers" : "Créer un dossier"}
          </button>
        </div>
      </details>
    </div>
  );
}
