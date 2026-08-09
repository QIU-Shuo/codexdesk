import { useEffect, useMemo, useRef, useState } from "react";
import type { GitBranchInfo, Project, UsageReport } from "../../shared/ipc";
import type { CurrentThreadListEntry } from "../compatibility/conversationPresentation";

export type DraftChatContext = {
  cwd: string;
  projectId: string | null;
  useWorktree: boolean;
  /** Null means use the current local working tree. */
  baseBranch: string | null;
};

export function NewChatWelcome({
  context,
  project,
  branchInfo,
  threads,
  onOpenThread,
  onOpenProject,
}: {
  context: DraftChatContext;
  project: Project | undefined;
  branchInfo: GitBranchInfo | null;
  threads: CurrentThreadListEntry[];
  onOpenThread: (threadId: string) => void;
  onOpenProject: () => void;
}) {
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const projectThreads = useMemo(
    () =>
      threads
        .filter(
          (thread) =>
            !thread.archived &&
            (project
              ? thread.projectId === project.id
              : thread.projectId === null && thread.cwd === context.cwd),
        )
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs),
    [context.cwd, project, threads],
  );
  const recentCount = projectThreads.filter(
    (thread) => Date.now() - thread.updatedAtMs < 3 * 86_400_000,
  ).length;
  const pickup = [...projectThreads]
    .sort(
      (a, b) =>
        pickupRank(a.status) - pickupRank(b.status) ||
        b.updatedAtMs - a.updatedAtMs,
    )
    .slice(0, 6);
  const activity = useMemo(
    () => activityCells(projectThreads),
    [projectThreads],
  );
  const projectName = project?.name ?? shortPath(context.cwd);
  const branch =
    context.baseBranch ??
    branchInfo?.currentBranch ??
    branchInfo?.defaultBranch;
  const lastThread = projectThreads[0];

  useEffect(() => {
    let live = true;
    void window.codexDesk.readUsage().then((report) => {
      if (live) setUsage(report);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!project) {
    return (
      <div className="new-chat-no-project">
        <span className="new-chat-no-project-mark" aria-hidden="true" />
        <h1>Welcome to CodexDesk</h1>
        <p>
          This chat has no project. Ask anything, or open a project to give
          Codex a checkout, a branch and a file tree to work in.
        </p>
        <button type="button" onClick={onOpenProject}>
          Open a project <kbd>⌘O</kbd>
        </button>
      </div>
    );
  }

  return (
    <div className="new-chat-home">
      <header className="new-chat-summary">
        <button
          type="button"
          className="new-chat-project-pill"
          onClick={onOpenProject}
        >
          {projectName}
          <span aria-hidden="true">⌄</span>
        </button>
        <p>
          {recentCount} recent chat{recentCount === 1 ? "" : "s"} in 3 days
        </p>
      </header>

      <div className="new-chat-dashboard">
        <div className="new-chat-dashboard-primary">
          <section className="new-chat-section checkout-overview">
            <SectionTitle
              label="This checkout"
              detail={branch ?? "No Git branch"}
            />
            <FactRow
              label={
                branchInfo
                  ? branchInfo.dirtyCount === 0
                    ? "Working tree is clean"
                    : `${branchInfo.dirtyCount} dirty file${branchInfo.dirtyCount === 1 ? "" : "s"}`
                  : "Git status unavailable"
              }
              detail={
                branchInfo
                  ? `${context.useWorktree ? "Isolated worktree" : "Local checkout"} on ${branch ?? "no branch"}`
                  : "Repository status could not be read"
              }
              action="Review"
            />
            <FactRow
              label={branch ?? "No Git branch"}
              detail={`Default branch ${branchInfo?.defaultBranch ?? "unavailable"}`}
              action="Branch"
            />
            <FactRow
              label={
                lastThread
                  ? lastThread.name || lastThread.preview || "Untitled chat"
                  : "No chats in this checkout"
              }
              detail={
                lastThread
                  ? `Last chat, ${formatRelativeAge(lastThread.updatedAtMs)} ago`
                  : "Start the first one below"
              }
              action={lastThread ? "Open" : undefined}
              onAction={
                lastThread
                  ? () => onOpenThread(lastThread.threadId)
                  : undefined
              }
            />
          </section>

          <section className="new-chat-section activity-overview">
            <SectionTitle label="Activity" detail="13 weeks" />
            <div
              className="new-chat-heatmap"
              aria-label="Chat activity over 13 weeks"
            >
              {activity.map((cell) => (
                <span
                  key={cell.key}
                  className={`level-${Math.min(cell.count, 3)}`}
                  title={`${cell.key}: ${cell.count} chat${cell.count === 1 ? "" : "s"}`}
                />
              ))}
            </div>
            <div className="new-chat-activity-note">
              <span>
                {projectThreads.length === 0
                  ? "No activity in this checkout yet."
                  : `${projectThreads.length} chat${projectThreads.length === 1 ? "" : "s"} in this checkout.`}
              </span>
              <span>less</span>
              <span className="new-chat-heatmap-legend" aria-hidden="true">
                {[0, 1, 2, 3].map((level) => (
                  <i key={level} className={`level-${level}`} />
                ))}
              </span>
              <span>more</span>
            </div>
          </section>
        </div>

        <section className="new-chat-section pickup-overview">
          <SectionTitle label="Pick up" detail="" />
          <div className="new-chat-pickup-list">
            {pickup.length === 0 ? (
              <p className="new-chat-empty">
                Your recent work will appear here.
              </p>
            ) : (
              pickup.map((thread) => (
                <button
                  key={thread.threadId}
                  type="button"
                  className="new-chat-pickup"
                  onClick={() => onOpenThread(thread.threadId)}
                >
                  <span className="pickup-copy">
                    <span>
                      <strong>
                        {thread.name || thread.preview || "Untitled chat"}
                      </strong>
                      <em className={thread.status}>
                        {pickupAction(thread.status)}
                      </em>
                    </span>
                    <small>
                      {statusLabel(thread.status)} · {formatRelativeAge(thread.updatedAtMs)}
                    </small>
                  </span>
                </button>
              ))
            )}
          </div>
          {projectThreads.length > pickup.length && (
            <p className="new-chat-pickup-older">
              + {projectThreads.length - pickup.length} older
            </p>
          )}
        </section>
      </div>

      <section className="usage-overview" aria-label="Account usage">
        <UsageFact
          label="Lifetime tokens"
          value={formatCount(usage?.lifetimeTokens)}
        />
        <UsageFact
          label="Current streak"
          value={formatDays(usage?.currentStreakDays)}
        />
        <UsageFact
          label="Peak day"
          value={formatCount(usage?.peakDailyTokens)}
        />
        <span className="new-chat-usage-label">Usage</span>
      </section>
    </div>
  );
}

function SectionTitle({ label, detail }: { label: string; detail: string }) {
  return (
    <header className="new-chat-section-title">
      <h2>{label}</h2>
      <span>{detail}</span>
    </header>
  );
}

function FactRow({
  label,
  detail,
  action,
  onAction,
}: {
  label: string;
  detail: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="new-chat-fact">
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      {action &&
        (onAction ? (
          <button type="button" onClick={onAction}>
            {action}
          </button>
        ) : (
          <span className="new-chat-fact-action">{action}</span>
        ))}
    </div>
  );
}

function UsageFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="new-chat-usage-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function pickupRank(status: CurrentThreadListEntry["status"]): number {
  return {
    waitingOnApproval: 0,
    waitingOnUserInput: 1,
    failed: 2,
    running: 3,
    idle: 4,
    notLoaded: 5,
  }[status];
}

function statusLabel(status: CurrentThreadListEntry["status"]): string {
  return {
    waitingOnApproval: "waiting for approval",
    waitingOnUserInput: "needs your input",
    failed: "last turn failed",
    running: "running now",
    idle: "ready to continue",
    notLoaded: "available on this machine",
  }[status];
}

function pickupAction(status: CurrentThreadListEntry["status"]): string {
  return {
    waitingOnApproval: "Approve",
    waitingOnUserInput: "Reply",
    failed: "Review",
    running: "View",
    idle: "Open",
    notLoaded: "Open",
  }[status];
}

function activityCells(threads: CurrentThreadListEntry[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const counts = new Map<string, number>();
  for (const thread of threads) {
    const key = dateKey(new Date(thread.updatedAtMs));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from({ length: 91 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (90 - index));
    const key = dateKey(date);
    return { key, count: counts.get(key) ?? 0 };
  });
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatRelativeAge(updatedAtMs: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - updatedAtMs) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function formatCount(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDays(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${value} day${value === 1 ? "" : "s"}`;
}

/**
 * New-chat context remains editable beside the composer until the first
 * message creates the durable conversation.
 */
export function NewChatContextBar({
  context,
  projects,
  branchInfo,
  loadingBranches,
  onChange,
  onAddProject,
}: {
  context: DraftChatContext;
  projects: Project[];
  branchInfo: GitBranchInfo | null;
  loadingBranches: boolean;
  onChange: (context: DraftChatContext) => void;
  onAddProject: () => void;
}) {
  const [menu, setMenu] = useState<"project" | "location" | "branch" | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const project = projects.find((item) => item.id === context.projectId);
  const projectLabel = project?.name ?? "No project";
  const branchLabel =
    context.baseBranch ??
    branchInfo?.currentBranch ??
    (loadingBranches ? "…" : "No Git");
  const filteredProjects = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return projects;
    return projects.filter((item) =>
      [item.name, ...item.roots]
        .join("\n")
        .toLocaleLowerCase()
        .includes(needle),
    );
  }, [projects, query]);
  const filteredBranches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const branches = branchInfo?.branches ?? [];
    return needle
      ? branches.filter((branch) => branch.toLocaleLowerCase().includes(needle))
      : branches;
  }, [branchInfo, query]);

  const toggle = (next: typeof menu) => {
    setQuery("");
    setMenu((current) => (current === next ? null : next));
  };
  const close = () => {
    setMenu(null);
    setQuery("");
  };

  useEffect(() => {
    if (!menu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [menu]);

  return (
    <div
      className={`new-chat-context${context.projectId ? "" : " no-project"}`}
      ref={wrapRef}
    >
      <ContextButton
        label="Select project"
        value={projectLabel}
        icon={<FolderIcon />}
        expanded={menu === "project"}
        onClick={() => toggle("project")}
      />
      {context.projectId && (
        <>
          <ContextButton
            label="Select location"
            value={context.useWorktree ? "Worktree" : "Local"}
            icon={<ComputerIcon />}
            expanded={menu === "location"}
            onClick={() => toggle("location")}
          />
          <ContextButton
            label="Select branch"
            value={branchLabel}
            icon={<BranchIcon />}
            expanded={menu === "branch"}
            disabled={!loadingBranches && !branchInfo}
            onClick={() => toggle("branch")}
          />
        </>
      )}

      {menu === "project" && (
        <ContextMenu className="project-menu" onEscape={close}>
          <MenuSearch
            autoFocus
            placeholder="Search projects"
            value={query}
            onChange={setQuery}
          />
          <div className="new-chat-menu-scroll">
            {filteredProjects.flatMap((item) =>
              item.roots.map((root) => (
                <button
                  key={`${item.id}:${root}`}
                  type="button"
                  className="new-chat-menu-item"
                  onClick={() => {
                    onChange({
                      ...context,
                      projectId: item.id,
                      cwd: root,
                      baseBranch: null,
                    });
                    close();
                  }}
                >
                  <FolderIcon />
                  <span>
                    <strong>{item.name}</strong>
                    {item.roots.length > 1 && <small>{shortPath(root)}</small>}
                  </span>
                  {context.projectId === item.id && context.cwd === root && (
                    <span className="menu-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              )),
            )}
          </div>
          <div className="new-chat-menu-separator" />
          <button
            type="button"
            className="new-chat-menu-item"
            onClick={() => {
              onAddProject();
              close();
            }}
          >
            <span className="menu-symbol" aria-hidden="true">
              ＋
            </span>
            New project…
          </button>
          <button
            type="button"
            className="new-chat-menu-item"
            onClick={() => {
              onChange({ ...context, projectId: null });
              close();
            }}
          >
            <span className="menu-symbol" aria-hidden="true">
              ×
            </span>
            Don&apos;t work in a project
          </button>
        </ContextMenu>
      )}

      {menu === "location" && (
        <ContextMenu onEscape={close}>
          <div className="new-chat-menu-title">Where should this chat run?</div>
          <button
            type="button"
            className="new-chat-menu-item"
            onClick={() => {
              onChange({ ...context, useWorktree: false, baseBranch: null });
              close();
            }}
          >
            <ComputerIcon />
            <span>
              <strong>Local checkout</strong>
              <small>Use the current files and changes</small>
            </span>
            {!context.useWorktree && (
              <span className="menu-check" aria-hidden="true">
                ✓
              </span>
            )}
          </button>
          <button
            type="button"
            className="new-chat-menu-item"
            onClick={() => {
              onChange({ ...context, useWorktree: true });
              close();
            }}
          >
            <BranchIcon />
            <span>
              <strong>Isolated worktree</strong>
              <small>Start from the selected branch</small>
            </span>
            {context.useWorktree && (
              <span className="menu-check" aria-hidden="true">
                ✓
              </span>
            )}
          </button>
        </ContextMenu>
      )}

      {menu === "branch" && branchInfo && (
        <ContextMenu className="branch-menu" onEscape={close}>
          <MenuSearch
            autoFocus
            placeholder="Search branches"
            value={query}
            onChange={setQuery}
          />
          {branchInfo.currentBranch &&
            (!query ||
              branchInfo.currentBranch
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase())) && (
              <>
                <div className="new-chat-menu-title">Local file state</div>
                <button
                  type="button"
                  className="new-chat-menu-item"
                  onClick={() => {
                    onChange({
                      ...context,
                      useWorktree: false,
                      baseBranch: null,
                    });
                    close();
                  }}
                >
                  <BranchIcon />
                  <span>
                    <strong>{branchInfo.currentBranch}</strong>
                    <small>
                      {branchInfo.dirtyCount > 0
                        ? `Uncommitted: ${branchInfo.dirtyCount} files`
                        : "Current checkout"}
                    </small>
                  </span>
                  {context.baseBranch === null && (
                    <span className="menu-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              </>
            )}
          <div className="new-chat-menu-title">Branches</div>
          <div className="new-chat-menu-scroll">
            {filteredBranches.map((branch) => (
              <button
                key={branch}
                type="button"
                className="new-chat-menu-item"
                onClick={() => {
                  onChange({
                    ...context,
                    useWorktree: true,
                    baseBranch: branch,
                  });
                  close();
                }}
              >
                <BranchIcon />
                <span>{branch}</span>
                {context.baseBranch === branch && (
                  <span className="menu-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            ))}
            {filteredBranches.length === 0 && (
              <div className="new-chat-menu-empty">No branches found</div>
            )}
          </div>
        </ContextMenu>
      )}
    </div>
  );
}

function ContextButton({
  label,
  value,
  icon,
  expanded,
  disabled,
  onClick,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  expanded: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="new-chat-context-button"
      aria-label={`${label}: ${value}`}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span>{value}</span>
      <span className="context-chevron" aria-hidden="true">
        ⌄
      </span>
    </button>
  );
}

function ContextMenu({
  className = "",
  children,
  onEscape,
}: {
  className?: string;
  children: React.ReactNode;
  onEscape: () => void;
}) {
  return (
    <div
      className={`new-chat-menu ${className}`}
      role="menu"
      onKeyDown={(event) => {
        if (event.key === "Escape") onEscape();
      }}
    >
      {children}
    </div>
  );
}

function MenuSearch({
  autoFocus,
  placeholder,
  value,
  onChange,
}: {
  autoFocus?: boolean;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="new-chat-menu-search">
      <span aria-hidden="true">⌕</span>
      <input
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function shortPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts.at(-1) ?? value;
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.25 4.25h4l1.25 1.5h6.25v6.5H2.25z" />
    </svg>
  );
}

function ComputerIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.5" y="3.25" width="11" height="8" rx="1.25" />
      <path d="M6 13h4" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="5" cy="3.5" r="1.25" />
      <circle cx="11.5" cy="5" r="1.25" />
      <circle cx="5" cy="12.5" r="1.25" />
      <path d="M5 4.75v6.5M6.25 8h1.5a3.75 3.75 0 0 0 3.75-1.75" />
    </svg>
  );
}
