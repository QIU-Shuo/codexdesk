import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { readProductStorage } from "./productStorage";
import type { Project } from "../../shared/ipc";
import type {
  CurrentThreadListEntry as ThreadListEntry,
  CurrentThreadRuntimeStatus,
} from "../compatibility/conversationPresentation";

type SortMode = "priority" | "updated" | "manual";
type SearchScope = "active" | "archived";

const RECENTS = "__recents__";
const PROJECT_INITIAL_ROWS = 4;
const RECENTS_INITIAL_ROWS = 8;

/**
 * Cross-project chat navigation.
 *
 * The main process owns project attribution; this component only groups and
 * orders the cheap catalog rows it receives. No transcript is loaded until a
 * row is opened. Sidebar preferences are UI-only and live in localStorage so
 * expanding a long project or choosing Priority survives a restart without
 * widening the main-process persistence contract.
 */
export function ThreadSidebar({
  width,
  threads,
  activeThreadId,
  newChatActive,
  onOpen,
  onNew,
  onPin,
  onArchive,
  onDelete,
  onRename,
  onOpenInNewWindow,
  projects,
  onRemoveProject,
  onRenameProject,
  onRevealProject,
  onRegisterIsolatedWorkspace,
  searchRequest = 0,
  accountLabel,
  onOpenUsage,
  onOpenCapabilities,
  onSignOut,
  onOpenFolder,
  onSearchFiles,
  canSearchFiles = true,
  filterRef,
  queuedThreadId,
  attention,
}: {
  width?: number;
  threads: ThreadListEntry[];
  activeThreadId: string | null;
  newChatActive?: boolean;
  onOpen: (id: string) => void;
  onNew: (context?: { cwd?: string; projectId?: string | null }) => void;
  onPin: (id: string, pinned: boolean) => void;
  onArchive: (id: string, archived: boolean) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onOpenInNewWindow: (id: string) => void;
  projects: Project[];
  onRemoveProject: (id: string) => void;
  onRenameProject?: (id: string, name: string) => void | Promise<void>;
  onRevealProject?: (projectId: string) => void;
  onRegisterIsolatedWorkspace?: (
    projectId: string,
    name: string,
  ) => Promise<{ error: string | null }>;
  searchRequest?: number;
  accountLabel?: string;
  onOpenUsage?: () => void;
  /** Skills, plugins, MCP, web search (§4.5 / V2.4). */
  onOpenCapabilities?: () => void;
  onSignOut?: () => void;
  onOpenFolder?: () => void;
  onSearchFiles?: () => void;
  canSearchFiles?: boolean;
  filterRef?: React.Ref<HTMLInputElement>;
  /** Active chat with a message waiting behind the current turn. */
  queuedThreadId?: string | null;
  attention?: { threadId: string; detail: string } | null;
}) {
  const compactRail = useMediaQuery("(max-width: 1099px)");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [searchScope, setSearchScope] = useState<SearchScope>("active");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const [sortMode] = useStoredState<SortMode>("codexdesk.sidebar.sort", "priority");
  const [collapsed, setCollapsed] = useStoredSet(
    "codexdesk.sidebar.collapsed-projects",
  );
  const [expanded, setExpanded] = useStoredSet(
    "codexdesk.sidebar.expanded-projects",
  );
  const [manualOrder, setManualOrder] = useStoredList(
    "codexdesk.sidebar.manual-order",
  );
  const [pinnedProjects, setPinnedProjects] = useStoredSet(
    "codexdesk.sidebar.pinned-projects",
  );
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [projectMenuFor, setProjectMenuFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmRemoveProject, setConfirmRemoveProject] = useState<
    string | null
  >(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [frozenOrder, setFrozenOrder] = useState<string[] | null>(null);
  const [detailThread, setDetailThread] = useState<ThreadListEntry | null>(
    null,
  );
  const [detailProject, setDetailProject] = useState<{
    project: Project;
    rows: ThreadListEntry[];
    top: number;
    left: number;
  } | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [projectRenameError, setProjectRenameError] = useState<string | null>(
    null,
  );
  const [creatingWorktreeFor, setCreatingWorktreeFor] =
    useState<Project | null>(null);
  const projectHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const now = useClock(normalThreadsRunning(threads));

  const cancelProjectHoverTimer = () => {
    if (projectHoverTimer.current) clearTimeout(projectHoverTimer.current);
    projectHoverTimer.current = null;
  };

  const showProjectDetails = (
    target: HTMLElement,
    project: Project,
    rows: ThreadListEntry[],
  ) => {
    cancelProjectHoverTimer();
    const rect = target.getBoundingClientRect();
    projectHoverTimer.current = setTimeout(() => {
      setDetailProject({
        project,
        rows,
        top: Math.max(8, Math.min(rect.top, window.innerHeight - 170)),
        left: rect.right + 8,
      });
    }, 260);
  };

  const hideProjectDetails = () => {
    cancelProjectHoverTimer();
    projectHoverTimer.current = setTimeout(() => setDetailProject(null), 120);
  };

  useEffect(
    () => () => {
      cancelProjectHoverTimer();
    },
    [],
  );

  const closeSearch = () => {
    setSearchOpen(false);
    setFilter("");
  };

  const openSearch = (scope: SearchScope) => {
    setSearchScope(scope);
    setFilter("");
    setSearchOpen(true);
    requestAnimationFrame(() => {
      const input = resolveRef(filterRef);
      input?.focus();
      input?.select();
    });
  };

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );

  // Keep the persisted manual order total as new chats arrive, while
  // preserving every choice the user already made.
  useEffect(() => {
    const ids = new Set(threads.map((thread) => thread.threadId));
    const next = [
      ...manualOrder.filter((id) => ids.has(id)),
      ...threads
        .map((thread) => thread.threadId)
        .filter((id) => !manualOrder.includes(id)),
    ];
    if (next.join("\0") !== manualOrder.join("\0")) setManualOrder(next);
  }, [threads, manualOrder, setManualOrder]);

  // The current chat must never disappear inside a collapsed project.
  useEffect(() => {
    const active = threads.find((thread) => thread.threadId === activeThreadId);
    if (!active) return;
    const key = active.projectId ?? RECENTS;
    if (collapsed.has(key)) {
      setCollapsed(new Set([...collapsed].filter((id) => id !== key)));
    }
  }, [activeThreadId, threads, collapsed, setCollapsed]);

  // The shortcut can request search even while the dialog is unmounted.
  useEffect(() => {
    if (searchRequest === 0) return;
    openSearch("active");
  }, [searchRequest, filterRef]);

  const normalThreads = threads.filter((thread) => !thread.archived);
  const currentOrder = useMemo(
    () =>
      orderThreads(normalThreads, sortMode, manualOrder, frozenOrder).map(
        (thread) => thread.threadId,
      ),
    [normalThreads, sortMode, manualOrder, frozenOrder],
  );

  const openRowMenu = (threadId: string) => {
    if (menuFor === threadId) {
      closeRowMenu();
      return;
    }
    setFrozenOrder(currentOrder);
    setMenuFor(threadId);
  };

  const closeRowMenu = () => {
    setMenuFor(null);
    setFrozenOrder(null);
    setConfirmDelete(null);
  };

  const searchThreads = threads.filter((thread) => {
    if (searchScope === "active" ? thread.archived : !thread.archived) {
      return false;
    }
    if (!filter.trim()) return true;
    const project = thread.projectId
      ? projectById.get(thread.projectId)?.name
      : "Recents";
    const haystack = [thread.name, thread.preview, thread.cwd, project]
      .filter(Boolean)
      .join("\n")
      .toLocaleLowerCase();
    return haystack.includes(filter.trim().toLocaleLowerCase());
  });

  const normalGroups = makeProjectGroups(
    orderThreads(normalThreads, sortMode, manualOrder, frozenOrder),
    projects,
  )
    .filter((group) => group.rows.length > 0)
    .sort((a, b) => {
      if (a.isRecents !== b.isRecents) return a.isRecents ? -1 : 1;
      const aPinned = a.project ? pinnedProjects.has(a.project.id) : false;
      const bPinned = b.project ? pinnedProjects.has(b.project.id) : false;
      return Number(bPinned) - Number(aPinned);
    });

  useEffect(() => {
    if (!accountMenuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccountMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [accountMenuOpen]);

  const renderThread = (thread: ThreadListEntry, contextLabel?: string) => (
    <ThreadRow
      key={`${contextLabel ?? "project"}-${thread.threadId}`}
      thread={thread}
      now={now}
      queued={thread.threadId === queuedThreadId}
      attentionDetail={
        attention?.threadId === thread.threadId ? attention.detail : null
      }
      active={thread.threadId === activeThreadId}
      contextLabel={contextLabel}
      renaming={renaming === thread.threadId}
      renameValue={renameValue}
      onRenameValue={setRenameValue}
      onFinishRename={() => {
        onRename(thread.threadId, renameValue);
        setRenaming(null);
      }}
      onCancelRename={() => setRenaming(null)}
      onOpen={() => onOpen(thread.threadId)}
      onShowDetails={() => setDetailThread(thread)}
      onHideDetails={() =>
        setDetailThread((current) =>
          current?.threadId === thread.threadId ? null : current,
        )
      }
      menuOpen={menuFor === thread.threadId}
      onToggleMenu={() => openRowMenu(thread.threadId)}
      onCloseMenu={closeRowMenu}
      menu={
        <>
          <button
            onClick={() => {
              setRenaming(thread.threadId);
              setRenameValue(thread.name ?? thread.preview ?? "");
              closeRowMenu();
            }}
          >
            Rename
          </button>
          <button onClick={() => onPin(thread.threadId, !thread.pinned)}>
            {thread.pinned ? "Unpin" : "Pin"}
          </button>
          <div className="menu-sep" />
          {confirmDelete === thread.threadId ? (
            <button
              className="danger"
              onClick={() => {
                onDelete(thread.threadId);
                closeRowMenu();
              }}
            >
              Really delete?
            </button>
          ) : (
            <button
              className="danger"
              onClick={(event) => {
                event.stopPropagation();
                setConfirmDelete(thread.threadId);
              }}
            >
              Delete
            </button>
          )}
        </>
      }
    />
  );

  // Kept in the public prop surface while existing callers migrate to the
  // focused menus from the updated mock.
  void onArchive;
  void onOpenInNewWindow;
  void onRevealProject;
  void onRegisterIsolatedWorkspace;

  if (compactRail) {
    return (
      <>
        <aside
          className="sidebar sidebar-compact"
          aria-label="Chat navigation"
          style={{ width }}
        >
          <span className="sidebar-logo" aria-hidden="true" />
          <button
            type="button"
            aria-label="New chat"
            title="New chat (⌘N)"
            onClick={() => onNew({ projectId: null })}
          >
            <PlusIcon />
          </button>
          <button
            ref={searchButtonRef}
            type="button"
            aria-label="Search chats"
            title="Search chats (⌘K)"
            onClick={() => openSearch("active")}
          >
            <SearchIcon />
          </button>
          <button className="active" type="button" aria-label="Chats">
            <ChatsIcon />
          </button>
          <button
            type="button"
            aria-label="Archived chats"
            onClick={() => openSearch("archived")}
          >
            <ArchiveIcon />
          </button>
          <span className="sidebar-compact-spacer" />
          <button
            type="button"
            aria-label="Account and settings"
            onClick={onOpenCapabilities}
          >
            <span className="account-avatar" aria-hidden="true">
              {(accountLabel ?? "C").slice(0, 1).toUpperCase()}
            </span>
          </button>
        </aside>
        {searchOpen && (
          <ChatSearchPalette
            threads={orderThreads(searchThreads, "updated", manualOrder, null)}
            projects={projects}
            query={filter}
            scope={searchScope}
            activeThreadId={activeThreadId}
            inputRef={filterRef}
            canSearchFiles={canSearchFiles}
            onQueryChange={setFilter}
            onScopeChange={setSearchScope}
            onClose={closeSearch}
            onOpenThread={(threadId) => {
              closeSearch();
              onOpen(threadId);
            }}
            onNew={() => {
              closeSearch();
              onNew({ projectId: null });
            }}
            onOpenFolder={() => {
              closeSearch();
              onOpenFolder?.();
            }}
            onSearchFiles={() => {
              closeSearch();
              onSearchFiles?.();
            }}
          />
        )}
      </>
    );
  }

  return (
    <aside
      className="sidebar"
      aria-label="Chat navigation"
      style={{ width }}
    >
      <div className="sidebar-brand">
        <span className="sidebar-wordmark">
          <span className="sidebar-logo" aria-hidden="true" />
          <span>CodexDesk</span>
        </span>
        <span className="sidebar-brand-actions">
          <button
            ref={searchButtonRef}
            className={`sidebar-icon-button${searchOpen ? " active" : ""}`}
            type="button"
            aria-label="Search chats"
            title="Search chats (⌘K)"
            onClick={() => (searchOpen ? closeSearch() : openSearch("active"))}
          >
            <SearchIcon />
          </button>
          <button
            className="sidebar-icon-button sidebar-new-button"
            type="button"
            aria-label="New chat"
            title="New chat (⌘N)"
            onClick={() => {
              closeSearch();
              onNew({ projectId: null });
            }}
          >
            <PlusIcon />
          </button>
        </span>
      </div>

      <div className="sidebar-scroll">
        {newChatActive && (
          <button
            className="sidebar-new-chat-row active"
            type="button"
            aria-current="page"
            onClick={() => onNew({ projectId: null })}
          >
            <PlusIcon />
            <span>New chat</span>
            <time>now</time>
          </button>
        )}

        <section className="sidebar-section projects-section">
          {normalGroups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            const activeIndex = group.rows.findIndex(
              (thread) => thread.threadId === activeThreadId,
            );
            const isExpanded = expanded.has(group.key);
            const initialRows = group.isRecents
              ? RECENTS_INITIAL_ROWS
              : PROJECT_INITIAL_ROWS;
            const count = isExpanded
              ? group.rows.length
              : Math.max(initialRows, activeIndex + 1);
            const shown = group.rows.slice(0, count);
            const project = group.project;
            return (
              <div className="project-group" key={group.key}>
                <div
                  className={`project-header${
                    projectMenuFor === group.key ? " actions-open" : ""
                  }${
                    project && editingProject?.id === project.id
                      ? " renaming"
                      : ""
                  }`}
                  onMouseEnter={(event) => {
                    if (project) {
                      showProjectDetails(
                        event.currentTarget,
                        project,
                        group.rows,
                      );
                    }
                  }}
                  onMouseLeave={hideProjectDetails}
                >
                  {project && editingProject?.id === project.id ? (
                    <form
                      className={`project-inline-rename${
                        projectRenameError ? " invalid" : ""
                      }`}
                      onSubmit={(event) => {
                        event.preventDefault();
                        const name = renameValue.trim();
                        if (!name) return;
                        const duplicate = projects.some(
                          (candidate) =>
                            candidate.id !== project.id &&
                            candidate.name.toLocaleLowerCase() ===
                              name.toLocaleLowerCase(),
                        );
                        if (duplicate) {
                          setProjectRenameError(
                            "A project with this name already exists",
                          );
                          return;
                        }
                        void Promise.resolve(
                          onRenameProject?.(project.id, name),
                        ).then(() => {
                          setEditingProject(null);
                          setProjectRenameError(null);
                        });
                      }}
                    >
                      <input
                        autoFocus
                        aria-label="Project name"
                        value={renameValue}
                        onFocus={(event) => event.currentTarget.select()}
                        onChange={(event) => {
                          setRenameValue(event.target.value);
                          setProjectRenameError(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            setEditingProject(null);
                            setProjectRenameError(null);
                          }
                        }}
                      />
                      <span aria-hidden="true">↵</span>
                      {projectRenameError && (
                        <small role="alert">{projectRenameError}</small>
                      )}
                    </form>
                  ) : (
                    <button
                      className="project-toggle"
                      type="button"
                      title={
                        project?.activeRoot ??
                        "Recent chats that are not assigned to a project"
                      }
                      aria-expanded={!isCollapsed}
                      onClick={() =>
                        setCollapsed(toggleSet(collapsed, group.key))
                      }
                    >
                      <span>{group.name}</span>
                      {project && pinnedProjects.has(project.id) && (
                        <span
                          className="project-pin-mark"
                          aria-label="Pinned project"
                          title="Pinned project"
                        >
                          ◆
                        </span>
                      )}
                      <span className="project-count">{group.rows.length}</span>
                      <ChevronIcon collapsed={isCollapsed} />
                    </button>
                  )}
                  {project && editingProject?.id !== project.id && (
                    <div className="project-actions">
                      <RowMenu
                        open={projectMenuFor === group.key}
                        label={`Project actions for ${group.name}`}
                        fixed
                        onToggle={() => {
                          setDetailProject(null);
                          setProjectMenuFor((current) =>
                            current === group.key ? null : group.key,
                          );
                        }}
                        onClose={() => {
                          setProjectMenuFor(null);
                          setConfirmRemoveProject(null);
                        }}
                      >
                        <button
                          onClick={() => {
                            setPinnedProjects(
                              toggleSet(pinnedProjects, project.id),
                            );
                            setProjectMenuFor(null);
                          }}
                        >
                          <span>
                            {pinnedProjects.has(project.id)
                              ? "Unpin project"
                              : "Pin project"}
                          </span>
                        </button>
                        <button
                          onClick={() => {
                            setEditingProject(project);
                            setRenameValue(project.name);
                            setProjectRenameError(null);
                            setProjectMenuFor(null);
                          }}
                        >
                          <span>Rename project</span>
                        </button>
                        <div className="menu-sep" />
                        {confirmRemoveProject === project.id ? (
                          <button
                            className="danger"
                            onClick={() => {
                              onRemoveProject(project.id);
                              setProjectMenuFor(null);
                              setConfirmRemoveProject(null);
                            }}
                          >
                            <span>Really remove project?</span>
                          </button>
                        ) : (
                          <button
                            className="danger"
                            onClick={() => setConfirmRemoveProject(project.id)}
                          >
                            <span>Remove</span>
                          </button>
                        )}
                      </RowMenu>
                      <button
                        className="project-new-chat"
                        type="button"
                        aria-label={`New chat in ${group.name}`}
                        title={`New chat in ${group.name}`}
                        onClick={() => {
                          onNew({
                            projectId: project.id,
                            cwd: project.activeRoot,
                          });
                          setProjectMenuFor(null);
                        }}
                      >
                        <ComposeIcon />
                      </button>
                    </div>
                  )}
                </div>
                {!isCollapsed && (
                  <div className="project-rows">
                    {shown.length === 0 ? (
                      <div className="sidebar-empty project-empty">
                        No active chats.
                      </div>
                    ) : (
                      shown.map((thread) => renderThread(thread))
                    )}
                    {(isExpanded || group.rows.length > shown.length) && (
                      <button
                        type="button"
                        className="show-more"
                        onClick={() =>
                          setExpanded(toggleSet(expanded, group.key))
                        }
                      >
                        {isExpanded
                          ? "Show less"
                          : `+ ${group.rows.length - shown.length} more`}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
        {normalGroups.length === 0 && (
          <div className="sidebar-empty sidebar-chat-empty">
            No chats yet.
          </div>
        )}
      </div>

      {detailThread && !searchOpen && !menuFor && !projectMenuFor && (
        <div className="sidebar-detail-card" aria-hidden="true">
          <strong>
            {detailThread.name || detailThread.preview || "(empty chat)"}
          </strong>
          <span>
            {detailThread.projectId
              ? (projectById.get(detailThread.projectId)?.name ??
                "Unknown project")
              : "Recent · not in a project"}
          </span>
          <code>{detailThread.cwd}</code>
          <span>
            {[
              statusPresentation(detailThread.status, detailThread.unread)
                .longLabel,
              detailThread.pinned ? "Pinned" : null,
              detailThread.worktreePath ? "Worktree" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      )}

      {detailProject &&
        !searchOpen &&
        !projectMenuFor &&
        !editingProject &&
        !creatingWorktreeFor && (
          <ProjectHoverCard
            detail={detailProject}
            pinned={pinnedProjects.has(detailProject.project.id)}
            onMouseEnter={cancelProjectHoverTimer}
            onMouseLeave={hideProjectDetails}
            onTogglePin={() =>
              setPinnedProjects(
                toggleSet(pinnedProjects, detailProject.project.id),
              )
            }
            onEdit={() => {
              setDetailProject(null);
              setEditingProject(detailProject.project);
            }}
          />
        )}

      <div className="sidebar-footer" ref={accountMenuRef}>
        <div className="sidebar-account" title={accountLabel ?? "codex · plus"}>
          <span className="account-avatar" aria-hidden="true">
            {(accountLabel ?? "C").slice(0, 1).toUpperCase()}
          </span>
          <span>{accountLabel ?? "codex · plus"}</span>
        </div>
        <button
          className="sidebar-settings"
          type="button"
          aria-label="Account and settings"
          aria-expanded={accountMenuOpen}
          onClick={() => setAccountMenuOpen((open) => !open)}
        >
          <SettingsIcon />
        </button>
        {accountMenuOpen && (
          <div className="sidebar-account-menu" role="menu">
            {onOpenUsage && (
              <button type="button" role="menuitem" onClick={onOpenUsage}>
                Usage
              </button>
            )}
            {onOpenCapabilities && (
              <button
                type="button"
                role="menuitem"
                onClick={onOpenCapabilities}
              >
                Settings
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => openSearch("archived")}
            >
              Archived chats
            </button>
            {onSignOut && (
              <button type="button" role="menuitem" onClick={onSignOut}>
                Sign out
              </button>
            )}
          </div>
        )}
      </div>

      {searchOpen && (
        <ChatSearchPalette
          threads={orderThreads(searchThreads, "updated", manualOrder, null)}
          projects={projects}
          query={filter}
          scope={searchScope}
          activeThreadId={activeThreadId}
          inputRef={filterRef}
          canSearchFiles={canSearchFiles}
          onQueryChange={setFilter}
          onScopeChange={(scope) => {
            setSearchScope(scope);
            setFilter("");
          }}
          onClose={() => {
            closeSearch();
            searchButtonRef.current?.focus();
          }}
          onOpenThread={(threadId) => {
            closeSearch();
            onOpen(threadId);
          }}
          onNew={() => {
            closeSearch();
            onNew({ projectId: null });
          }}
          onOpenFolder={() => {
            closeSearch();
            onOpenFolder?.();
          }}
          onSearchFiles={() => {
            closeSearch();
            onSearchFiles?.();
          }}
        />
      )}

      {creatingWorktreeFor && (
        <IsolatedWorkspaceDialog
          project={creatingWorktreeFor}
          onClose={() => setCreatingWorktreeFor(null)}
          onCreate={async (name) => {
            if (!onRegisterIsolatedWorkspace) {
              return { error: "Isolated workspaces are unavailable." };
            }
            return onRegisterIsolatedWorkspace(creatingWorktreeFor.id, name);
          }}
        />
      )}
    </aside>
  );
}

function ProjectHoverCard({
  detail,
  pinned,
  onMouseEnter,
  onMouseLeave,
  onTogglePin,
  onEdit,
}: {
  detail: {
    project: Project;
    rows: ThreadListEntry[];
    top: number;
    left: number;
  };
  pinned: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onTogglePin: () => void;
  onEdit: () => void;
}) {
  const active = detail.rows.filter((thread) =>
    ["running", "waitingOnApproval", "waitingOnUserInput"].includes(
      thread.status,
    ),
  ).length;
  return (
    <div
      className="project-hover-card"
      style={{ top: detail.top, left: detail.left }}
      aria-label={`Project details for ${detail.project.name}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="project-hover-title">
        <FolderIcon />
        <strong>{detail.project.name}</strong>
        <button
          type="button"
          aria-label={pinned ? "Unpin project" : "Pin project"}
          title={pinned ? "Unpin project" : "Pin project"}
          onClick={onTogglePin}
        >
          <PinIcon />
        </button>
      </div>
      <div className="project-hover-summary">
        <span className="project-hover-status" aria-hidden="true" />
        <span>
          {detail.rows.length} {detail.rows.length === 1 ? "task" : "tasks"}
          {active > 0 && ` · ${active} active`}
        </span>
      </div>
      <div className="project-hover-row path" title={detail.project.activeRoot}>
        <FolderIcon />
        <span>{detail.project.activeRoot}</span>
      </div>
      <button className="project-hover-row edit" type="button" onClick={onEdit}>
        <SettingsIcon />
        <span>Edit project</span>
      </button>
    </div>
  );
}

function IsolatedWorkspaceDialog({
  project,
  onClose,
  onCreate,
}: {
  project: Project;
  onClose: () => void;
  onCreate: (name: string) => Promise<{ error: string | null }>;
}) {
  const [name, setName] = useState(`${project.name} isolated`);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !creating) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creating, onClose]);

  return (
    <div
      className="project-dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !creating) onClose();
      }}
    >
      <form
        className="project-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Create isolated workspace"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || creating) return;
          setCreating(true);
          setError(null);
          void onCreate(name.trim()).then((result) => {
            if (result.error) {
              setError(result.error);
              setCreating(false);
            } else {
              onClose();
            }
          });
        }}
      >
        <header>
          <h2>Create isolated workspace</h2>
          <p>
            Create a Git worktree from HEAD and register it as a workspace that
            is independent of this chat.
          </p>
        </header>
        <label>
          <span>Workspace name</span>
          <input
            autoFocus
            aria-label="Workspace name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error && <p className="project-dialog-error">{error}</p>}
        <footer>
          <button type="button" disabled={creating} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            type="submit"
            disabled={!name.trim() || creating}
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function ChatSearchPalette({
  threads,
  projects,
  query,
  scope,
  activeThreadId,
  inputRef,
  canSearchFiles,
  onQueryChange,
  onScopeChange,
  onClose,
  onOpenThread,
  onNew,
  onOpenFolder,
  onSearchFiles,
}: {
  threads: ThreadListEntry[];
  projects: Project[];
  query: string;
  scope: SearchScope;
  activeThreadId: string | null;
  inputRef?: React.Ref<HTMLInputElement>;
  canSearchFiles: boolean;
  onQueryChange: (query: string) => void;
  onScopeChange: (scope: SearchScope) => void;
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
  onNew: () => void;
  onOpenFolder: () => void;
  onSearchFiles: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const results = threads.slice(0, 9);
  const showSuggested = scope === "active" && query.trim() === "";
  const suggestions = showSuggested
    ? [
        { label: "New chat", shortcut: "⌘N", action: onNew, disabled: false },
        {
          label: "Open folder",
          shortcut: "⌘O",
          action: onOpenFolder,
          disabled: false,
        },
        {
          label: "Search files",
          shortcut: "⌘P",
          action: onSearchFiles,
          disabled: !canSearchFiles,
        },
      ]
    : [];
  const itemCount = results.length + suggestions.length;

  useEffect(() => setSelectedIndex(0), [query, scope]);
  useEffect(() => {
    if (selectedIndex >= itemCount) {
      setSelectedIndex(Math.max(0, itemCount - 1));
    }
  }, [itemCount, selectedIndex]);

  const activate = (index: number) => {
    const thread = results[index];
    if (thread) {
      onOpenThread(thread.threadId);
      return;
    }
    const suggestion = suggestions[index - results.length];
    if (suggestion && !suggestion.disabled) suggestion.action();
  };

  return (
    <div
      className="chat-search-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="chat-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={
          scope === "archived" ? "Search archived chats" : "Search chats"
        }
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          const modifiedKey = event.metaKey || event.ctrlKey;
          if (modifiedKey && event.key.toLocaleLowerCase() === "n") {
            event.preventDefault();
            event.stopPropagation();
            onNew();
            return;
          }
          if (modifiedKey && event.key.toLocaleLowerCase() === "o") {
            event.preventDefault();
            event.stopPropagation();
            onOpenFolder();
            return;
          }
          if (modifiedKey && event.key.toLocaleLowerCase() === "p") {
            event.preventDefault();
            event.stopPropagation();
            if (canSearchFiles) onSearchFiles();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "ArrowDown" && itemCount > 0) {
            event.preventDefault();
            setSelectedIndex((index) => (index + 1) % itemCount);
            return;
          }
          if (event.key === "ArrowUp" && itemCount > 0) {
            event.preventDefault();
            setSelectedIndex((index) => (index - 1 + itemCount) % itemCount);
            return;
          }
          if (event.key === "Enter" && itemCount > 0) {
            event.preventDefault();
            activate(selectedIndex);
            return;
          }
          if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
            const index = Number(event.key) - 1;
            if (results[index]) {
              event.preventDefault();
              activate(index);
            }
          }
        }}
      >
        <div className="chat-search-scopes" aria-label="Search scope">
          <button
            type="button"
            className={scope === "active" ? "active" : ""}
            aria-pressed={scope === "active"}
            onClick={() => onScopeChange("active")}
          >
            Chats
          </button>
          <button
            type="button"
            className={scope === "archived" ? "active" : ""}
            aria-pressed={scope === "archived"}
            onClick={() => onScopeChange("archived")}
          >
            Archived
          </button>
        </div>
        <label className="chat-search-input">
          <SearchIcon />
          <input
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-label={
              scope === "archived" ? "Search archived chats" : "Search chats"
            }
            aria-controls="chat-search-results"
            aria-expanded="true"
            aria-activedescendant={
              itemCount > 0 ? `chat-search-item-${selectedIndex}` : undefined
            }
            placeholder={
              scope === "archived" ? "Search archived chats" : "Search chats"
            }
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onQueryChange("")}
            >
              ×
            </button>
          )}
        </label>

        <div
          className="chat-search-results"
          id="chat-search-results"
          role="listbox"
          aria-label={scope === "archived" ? "Archived chats" : "Chats"}
        >
          <div className="chat-search-group-label">
            {scope === "archived" ? "Archived" : "Chats"}
          </div>
          {results.map((thread, index) => {
            const title = thread.name || thread.preview || "(empty chat)";
            const project = thread.projectId
              ? projectById.get(thread.projectId)?.name
              : shortPath(thread.cwd);
            return (
              <button
                id={`chat-search-item-${index}`}
                key={thread.threadId}
                type="button"
                role="option"
                aria-selected={selectedIndex === index}
                className={`chat-search-result${
                  selectedIndex === index ? " selected" : ""
                }`}
                onPointerMove={() => setSelectedIndex(index)}
                onClick={() => onOpenThread(thread.threadId)}
              >
                <span
                  className={`chat-search-status ${thread.status}${
                    thread.threadId === activeThreadId ? " active" : ""
                  }`}
                  aria-hidden="true"
                />
                <span className="chat-search-title">{title}</span>
                <span className="chat-search-project">{project}</span>
                <kbd>⌘{index + 1}</kbd>
              </button>
            );
          })}
          {results.length === 0 && (
            <div className="chat-search-empty">No matching chats.</div>
          )}

          {suggestions.length > 0 && (
            <>
              <div className="chat-search-group-label suggested">Suggested</div>
              {suggestions.map((suggestion, offset) => {
                const index = results.length + offset;
                return (
                  <button
                    id={`chat-search-item-${index}`}
                    key={suggestion.label}
                    type="button"
                    role="option"
                    aria-selected={selectedIndex === index}
                    className={`chat-search-result command${
                      selectedIndex === index ? " selected" : ""
                    }`}
                    disabled={suggestion.disabled}
                    onPointerMove={() => setSelectedIndex(index)}
                    onClick={suggestion.action}
                  >
                    <span
                      className="chat-search-command-icon"
                      aria-hidden="true"
                    >
                      {offset === 0 ? "✎" : offset === 1 ? "▱" : "⌕"}
                    </span>
                    <span className="chat-search-title">
                      {suggestion.label}
                    </span>
                    <kbd>{suggestion.shortcut}</kbd>
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ThreadRow({
  thread,
  active,
  now,
  queued,
  attentionDetail,
  contextLabel,
  renaming,
  renameValue,
  onRenameValue,
  onFinishRename,
  onCancelRename,
  onOpen,
  onShowDetails,
  onHideDetails,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  menu,
}: {
  thread: ThreadListEntry;
  active: boolean;
  now: number;
  queued: boolean;
  attentionDetail: string | null;
  contextLabel?: string;
  renaming: boolean;
  renameValue: string;
  onRenameValue: (value: string) => void;
  onFinishRename: () => void;
  onCancelRename: () => void;
  onOpen: () => void;
  onShowDetails: () => void;
  onHideDetails: () => void;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  menu: React.ReactNode;
}) {
  const title = thread.name || thread.preview || "(empty chat)";
  const state = statusPresentation(thread.status, thread.unread);
  return (
    <div
      className={`thread-row${active ? " active" : ""}${
        thread.unread ? " unread" : ""
      }${queued ? " queued" : ""}${
        menuOpen ? " actions-open" : ""
      } ${state.className}`}
      title={thread.failureMessage ?? undefined}
      tabIndex={0}
      role="button"
      aria-label={`${title}${state.label ? `, ${state.label}` : ""}`}
      aria-current={active || undefined}
      onMouseEnter={onShowDetails}
      onMouseLeave={onHideDetails}
      onFocus={onShowDetails}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onHideDetails();
        }
      }}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="thread-row-main">
        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            aria-label="Chat name"
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => onRenameValue(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") onFinishRename();
              if (event.key === "Escape") onCancelRename();
            }}
            onBlur={onCancelRename}
          />
        ) : (
          <>
            {thread.unread && (
              <span className="thread-unread-dot" aria-hidden="true" />
            )}
            <span className="thread-title" title={title}>
              {title}
              {queued && <em>queued</em>}
            </span>
          </>
        )}
        {thread.pinned && (
          <span
            className="thread-mini-badge"
            title="Pinned"
            aria-label="Pinned"
          >
            ◆
          </span>
        )}
        {thread.worktreePath && (
          <span
            className="thread-mini-badge worktree"
            title="Worktree"
            aria-label="Worktree"
          >
            ⑂
          </span>
        )}
        <RowMenu
          open={menuOpen}
          label={`Actions for ${title}`}
          onToggle={onToggleMenu}
          onClose={onCloseMenu}
        >
          {menu}
        </RowMenu>
        <time className={`thread-time ${state.className}`}>
          {queued
            ? "—"
            : thread.status === "running" && thread.startedAtMs !== null
              ? formatDuration(now - thread.startedAtMs)
              : formatRelativeAge(thread.updatedAtMs, now)}
        </time>
      </div>
      {attentionDetail && (
        <div className="thread-attention-detail">{attentionDetail}</div>
      )}
      {contextLabel && <div className="thread-context">{contextLabel}</div>}
    </div>
  );
}

function formatRelativeAge(updatedAtMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - updatedAtMs) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/** A keyboard-reachable menu that closes on Escape or an outside click. */
function RowMenu({
  open,
  label,
  fixed = false,
  onToggle,
  onClose,
  children,
}: {
  open: boolean;
  label: string;
  fixed?: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  const [fixedPosition, setFixedPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !ref.current?.contains(target) &&
        !itemsRef.current?.contains(target)
      ) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => {
      itemsRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      if (fixed && itemsRef.current) {
        const rect = itemsRef.current.getBoundingClientRect();
        const overflowBottom = Math.max(
          0,
          rect.bottom - window.innerHeight + 8,
        );
        const overflowRight = Math.max(0, rect.right - window.innerWidth + 8);
        if (overflowBottom || overflowRight) {
          setFixedPosition((current) =>
            current
              ? {
                  top: Math.max(8, current.top - overflowBottom),
                  left: Math.max(8, current.left - overflowRight),
                }
              : current,
          );
        }
      }
    });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [fixed, open, onClose]);

  const items = open ? (
    <div
      ref={itemsRef}
      className={`rowmenu-items${fixed ? " fixed" : ""}`}
      style={fixedPosition ?? undefined}
    >
      {children}
    </div>
  ) : null;

  return (
    <div
      className="rowmenu"
      ref={ref}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        ref={triggerRef}
        className="rowmenu-trigger"
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          if (fixed && !open) {
            const rect = triggerRef.current?.getBoundingClientRect();
            if (rect) {
              setFixedPosition({
                top: Math.max(
                  8,
                  Math.min(rect.bottom + 4, window.innerHeight - 224),
                ),
                left: Math.max(8, Math.min(rect.left, window.innerWidth - 224)),
              });
            }
          }
          onToggle();
        }}
      >
        ⋯
      </button>
      {fixed && items ? createPortal(items, document.body) : items}
    </div>
  );
}

type ProjectGroup = {
  key: string;
  name: string;
  project: Project | null;
  isRecents: boolean;
  rows: ThreadListEntry[];
};

function makeProjectGroups(
  rows: ThreadListEntry[],
  projects: Project[],
): ProjectGroup[] {
  const byProject = new Map<string, ThreadListEntry[]>();
  for (const row of rows) {
    const key = row.projectId ?? RECENTS;
    byProject.set(key, [...(byProject.get(key) ?? []), row]);
  }
  const recents = byProject.get(RECENTS) ?? [];
  const groups: ProjectGroup[] = recents.length
    ? [
        {
          key: RECENTS,
          name: "Recents",
          project: null,
          isRecents: true,
          rows: recents,
        },
      ]
    : [];
  groups.push(
    ...projects.map((project) => ({
      key: project.id,
      name: project.name,
      project,
      isRecents: false,
      rows: byProject.get(project.id) ?? [],
    })),
  );
  return groups;
}

export function orderThreads(
  rows: ThreadListEntry[],
  mode: SortMode,
  manualOrder: string[],
  frozenOrder: string[] | null,
): ThreadListEntry[] {
  const frozenIndex = new Map(
    (frozenOrder ?? []).map((id, index) => [id, index]),
  );
  const manualIndex = new Map(manualOrder.map((id, index) => [id, index]));
  return [...rows].sort((a, b) => {
    if (frozenOrder) {
      return (
        (frozenIndex.get(a.threadId) ?? Number.MAX_SAFE_INTEGER) -
        (frozenIndex.get(b.threadId) ?? Number.MAX_SAFE_INTEGER)
      );
    }
    if (mode === "manual") {
      return (
        (manualIndex.get(a.threadId) ?? Number.MAX_SAFE_INTEGER) -
        (manualIndex.get(b.threadId) ?? Number.MAX_SAFE_INTEGER)
      );
    }
    if (mode === "priority") {
      const attention = attentionRank(a) - attentionRank(b);
      if (attention !== 0) return attention;
    }
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAtMs - a.updatedAtMs;
  });
}

function attentionRank(thread: ThreadListEntry): number {
  switch (thread.status) {
    case "waitingOnUserInput":
      return 0;
    case "waitingOnApproval":
      return 1;
    case "failed":
      return 2;
    case "running":
      return 3;
    default:
      return thread.unread ? 4 : 5;
  }
}

function statusPresentation(
  status: CurrentThreadRuntimeStatus,
  unread: boolean,
) {
  switch (status) {
    case "waitingOnUserInput":
      return {
        className: "needs-input",
        symbol: "!",
        label: "Needs input",
        longLabel: "Needs input",
      };
    case "waitingOnApproval":
      return {
        className: "approval",
        symbol: "?",
        label: "Awaiting approval",
        longLabel: "Awaiting approval",
      };
    case "failed":
      return {
        className: "failed",
        symbol: "×",
        label: "Failed",
        longLabel: "Failed",
      };
    case "running":
      return {
        className: "running",
        symbol: "",
        label: "Running",
        longLabel: "Running",
      };
    default:
      return unread
        ? {
            className: "unread",
            symbol: "•",
            label: "Unread",
            longLabel: "Unread",
          }
        : {
            className: "idle",
            symbol: "",
            label: "",
            longLabel: "Idle",
          };
  }
}

function toggleSet(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function resolveRef(
  ref: React.Ref<HTMLInputElement> | undefined,
): HTMLInputElement | null {
  return ref && typeof ref === "object" ? ref.current : null;
}

function shortPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts.at(-1) ?? value;
}

function normalThreadsRunning(threads: ThreadListEntry[]): boolean {
  return threads.some((thread) => thread.status === "running");
}

function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function useStoredState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      return (JSON.parse(readProductStorage(key) ?? "null") as T) ?? fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(
    () => localStorage.setItem(key, JSON.stringify(value)),
    [key, value],
  );
  return [value, setValue] as const;
}

function useStoredSet(key: string) {
  const [list, setList] = useStoredState<string[]>(key, []);
  const set = useMemo(() => new Set(list), [list]);
  const update = (next: Set<string>) => setList([...next]);
  return [set, update] as const;
}

function useStoredList(key: string) {
  return useStoredState<string[]>(key, []);
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3 3" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.75 4.5h10.5v8.25H2.75zM2.25 2.5h11.5v2H2.25zM6 7h4" />
    </svg>
  );
}

function ChatsIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 3.25h11v7.25h-6l-3.5 2.25v-2.25H2.5z" />
      <path d="M5 6h6M5 8h4" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.25 4.25h4l1.25 1.5h6.25v6.5H2.25z" />
    </svg>
  );
}

function ComposeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.75 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V6.25" />
      <path d="m7 9 1.2-2.7 4.55-4.55a1.06 1.06 0 0 1 1.5 1.5L9.7 7.8 7 9Z" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m5.25 2.25 5.5 5.5M9.75 1.75l4.5 4.5-2.1 1.1-.9 3.15-1.5 1.5-5.75-5.75 1.5-1.5 3.15-.9 1.1-2.1ZM6.25 10.25l-4.5 4" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="2" />
      <path d="m6.75 2.1.35-1.1h1.8l.35 1.1 1.15.48 1.05-.54 1.27 1.27-.54 1.05.48 1.15 1.1.35v1.8l-1.1.35-.48 1.15.54 1.05-1.27 1.27-1.05-.54-1.15.48-.35 1.1H7.1l-.35-1.1-1.15-.48-1.05.54-1.27-1.27.54-1.05-.48-1.15-1.1-.35v-1.8l1.1-.35.48-1.15-.54-1.05 1.27-1.27 1.05.54 1.15-.48Z" />
    </svg>
  );
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className={`chevron${collapsed ? " collapsed" : ""}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d="m5.5 6.25 2.5 2.5 2.5-2.5" />
    </svg>
  );
}
