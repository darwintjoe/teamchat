"use client";

import { useEffect, useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useAction, useMutation, useQuery, useConvexConnectionState } from "convex/react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { formatShort } from "@/lib/format";
import type { Conversation as ConversationAddress } from "@/lib/cache";
import { ConversationView } from "@/components/Conversation";
import { ActionInbox } from "@/components/ActionInbox";
import { WidgetAdmin } from "@/components/WidgetAdmin";
import { IntegrationAdmin } from "@/components/IntegrationAdmin";
import { CostAdmin } from "@/components/CostAdmin";
import {
  clearLocalPin,
  hasLocalPin,
  isUnlockedThisSession,
  markUnlocked,
  platformBiometricAvailable,
  setLocalPin,
  verifyLocalPin,
  lockLocal,
} from "@/lib/pin";

type ConversationRow = {
  kind: "group" | "dm";
  publicId: string | null;
  peerPublicId: string | null;
  peerName: string | null;
  name: string;
  path: string | null;
  orgPublicId: string | null;
  role: "owner" | "manager" | "member";
  lastMessageAt: number;
  lastReadAt: number | null;
};

type Selection = {
  conversation: ConversationAddress;
  label: string;
  groupPath: string | null;
};

/** Live socket status. Convex reconnects with jittered exponential backoff (1s base, 16s cap). */
function ConnectionChip() {
  const state = useConvexConnectionState();
  const label = state.isWebSocketConnected
    ? "live"
    : state.hasEverConnected
      ? "reconnecting · 1–16s jitter"
      : "connecting";
  return (
    <span
      className={`conn-chip${state.isWebSocketConnected ? " live" : ""}`}
      title={
        state.isWebSocketConnected
          ? `WebSocket live · ${state.connectionCount} connect(s)`
          : `Retries: ${state.connectionRetries} · backoff is jittered exponential (1s base, 16s cap)`
      }
    >
      {label}
    </span>
  );
}

/** The on-demand count only mounts (and therefore only subscribes) when a number is rendered. */
function UnreadCount({ conversation }: { conversation: ConversationAddress }) {
  const count = useQuery(api.unread.unreadCount, { conversation });
  if (count === undefined || count.count === 0) return null;
  return <span className="unread-count">{count.display}</span>;
}

function ConversationRowItem({
  row,
  active,
  onOpen,
}: {
  row: ConversationRow;
  active: boolean;
  onOpen: () => void;
}) {
  const [showCount, setShowCount] = useState(false);
  const conversation: ConversationAddress | null =
    row.kind === "group" && row.publicId !== null
      ? { kind: "group", publicId: row.publicId }
      : row.kind === "dm" && row.peerPublicId !== null
        ? { kind: "dm", peerPublicId: row.peerPublicId }
        : null;

  const unreadArgs =
    conversation === null
      ? ("skip" as const)
      : conversation.kind === "group" && row.path !== null
        ? { conversation, groupPath: row.path }
        : { conversation };
  const unread = useQuery(api.unread.hasUnread, unreadArgs);

  return (
    <button
      type="button"
      className={`conv-row${active ? " active" : ""}`}
      onClick={onOpen}
      disabled={conversation === null}
      onMouseEnter={() => setShowCount(true)}
      onMouseLeave={() => setShowCount(false)}
      onFocus={() => setShowCount(true)}
      onBlur={() => setShowCount(false)}
    >
      <span className="conv-main">
        <span className="conv-name">
          {row.kind === "dm" ? "DM · " : ""}
          {row.name}
        </span>
        <span className="conv-sub">
          {row.kind === "group" ? row.path : "Direct message"}
          {row.lastMessageAt > 0 ? ` · ${formatShort(row.lastMessageAt)}` : ""}
        </span>
      </span>
      {showCount && conversation !== null && unread === true ? (
        <UnreadCount conversation={conversation} />
      ) : unread === true ? (
        <span className="unread-dot" aria-label="Unread" />
      ) : null}
    </button>
  );
}

/** Thin web client: organisations, flat groups, conversations, sends, invites, connections, DMs. */
export function Workspace() {
  const { signOut } = useAuthActions();
  const me = useQuery(api.users.me);
  const orgs = useQuery(api.organizations.listMine);
  const conversations = useQuery(api.groups.listMine);
  const connections = useQuery(api.connections.list);

  const createOrg = useMutation(api.organizations.create);
  const updateOrg = useMutation(api.organizations.update);
  const createGroup = useMutation(api.groups.create);
  const createInvite = useMutation(api.invites.create);
  const redeemInvite = useAction(api.invites.redeem);
  const requestConnection = useMutation(api.connections.requestByEmail);
  const acceptConnection = useMutation(api.connections.accept);
  const createDm = useMutation(api.groups.createDm);
  const setS3Config = useMutation(api.storage.config.setS3Config);

  const [orgPublicId, setOrgPublicId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);

  const storageState = useQuery(
    api.storage.config.myStorageState,
    orgPublicId !== null ? { orgPublicId } : "skip",
  );

  const [orgName, setOrgName] = useState("");
  const [orgAllowDms, setOrgAllowDms] = useState(true);
  const [showCreateOrg, setShowCreateOrg] = useState(false);

  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState("");

  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteInput, setInviteInput] = useState("");

  const [connectionEmail, setConnectionEmail] = useState("");
  const [dmPublicId, setDmPublicId] = useState("");

  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [storageForm, setStorageForm] = useState({
    endpoint: process.env.NEXT_PUBLIC_DEV_STORAGE_ENDPOINT ?? "",
    bucket: process.env.NEXT_PUBLIC_DEV_STORAGE_BUCKET ?? "teamchat",
    region: "us-east-1",
    keyPrefix: "teamchat",
    pendingPrefix: "pending",
    accessKeyId: process.env.NEXT_PUBLIC_DEV_STORAGE_ACCESS_KEY ?? "",
    secretAccessKey: process.env.NEXT_PUBLIC_DEV_STORAGE_SECRET_KEY ?? "",
  });

  const [hasPin, setHasPin] = useState(false);
  const [locked, setLocked] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [biometricAvailable, setBiometricAvailable] = useState(false);

  const orgList = orgs ?? [];
  const currentOrg = orgList.find((org) => org.publicId === orgPublicId) ?? null;

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("invite");
    if (token !== null && token.trim() !== "") setInviteInput(token.trim());
  }, []);

  useEffect(() => {
    if (orgPublicId === null && orgList.length > 0) setOrgPublicId(orgList[0].publicId);
  }, [orgList, orgPublicId]);

  useEffect(() => {
    setHasPin(hasLocalPin());
    if (hasLocalPin() && !isUnlockedThisSession()) setLocked(true);
    void platformBiometricAvailable().then(setBiometricAvailable);
  }, []);

  function show(kind: "ok" | "err", text: string) {
    setNotice({ kind, text });
  }

  const rows = (conversations ?? []).filter(
    (row) =>
      row.kind === "dm" ||
      orgPublicId === null ||
      row.orgPublicId === orgPublicId,
  );

  function openRow(row: ConversationRow) {
    setInboxOpen(false);
    if (row.kind === "group" && row.publicId !== null) {
      setSelected({
        conversation: { kind: "group", publicId: row.publicId },
        label: row.name,
        groupPath: row.path,
      });
    } else if (row.kind === "dm" && row.peerPublicId !== null) {
      setSelected({
        conversation: { kind: "dm", peerPublicId: row.peerPublicId },
        label: row.peerName ?? row.name,
        groupPath: null,
      });
    }
  }

  async function onCreateOrg(event: React.FormEvent) {
    event.preventDefault();
    if (orgName.trim() === "") return;
    try {
      const result = await createOrg({ name: orgName.trim(), allowDirectMessages: orgAllowDms });
      setOrgName("");
      setShowCreateOrg(false);
      setOrgPublicId(result.orgPublicId);
      show("ok", `Created ${result.name} with root group ${result.rootGroupPublicId}`);
    } catch (caught) {
      show("err", errorMessage(caught));
    }
  }

  async function onCreateGroup(event: React.FormEvent) {
    event.preventDefault();
    if (orgPublicId === null || groupName.trim() === "") return;
    try {
      const result = await createGroup({
        orgPublicId,
        name: groupName.trim(),
        memberPublicIds: groupMembers
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value !== ""),
      });
      setSelected({
        conversation: { kind: "group", publicId: result.groupPublicId },
        label: groupName.trim(),
        groupPath: result.path,
      });
      setInboxOpen(false);
      setGroupName("");
      setGroupMembers("");
      show("ok", `Group created at ${result.path}`);
    } catch (caught) {
      show("err", errorMessage(caught));
    }
  }

  async function onCreateInvite() {
    if (orgPublicId === null) return;
    try {
      const result = await createInvite({ orgPublicId });
      setInviteToken(result.token);
      show("ok", "Invite created — the token is shown only once. Copy the link now.");
    } catch (caught) {
      show("err", errorMessage(caught));
    }
  }

  async function onRedeemInvite(event: React.FormEvent) {
    event.preventDefault();
    const token = inviteInput.trim();
    if (token === "") return;
    try {
      const result = await redeemInvite({ token });
      setInviteInput("");
      setOrgPublicId(result.orgPublicId);
      show("ok", result.alreadyMember ? `Already a member of ${result.orgName}` : `Joined ${result.orgName}`);
    } catch (caught) {
      show("err", errorMessage(caught));
    }
  }

  async function onRequestConnection(event: React.FormEvent) {
    event.preventDefault();
    if (connectionEmail.trim() === "") return;
    try {
      const result = await requestConnection({ email: connectionEmail.trim() });
      setConnectionEmail("");
      if (!result.found) {
        show("err", "No TeamChat account with that email (the lookup reveals nothing else).");
      } else {
        show("ok", `Request ${result.created ? "sent to" : "already exists with"} ${result.peerName ?? "that user"} (${result.status})`);
      }
    } catch (caught) {
      show("err", errorMessage(caught));
    }
  }

  async function onAcceptConnection(peerPublicId: string) {
    try {
      await acceptConnection({ userPublicId: peerPublicId });
      show("ok", "Connection accepted — you can now open a direct message.");
    } catch (caught) {
      show("err", errorMessage(caught));
    }
  }

  async function onOpenDm(userPublicId: string) {
    if (userPublicId.trim() === "") return;
    try {
      const result = await createDm({ userPublicId: userPublicId.trim() });
      setSelected({
        conversation: { kind: "dm", peerPublicId: result.peerPublicId },
        label: result.peerName ?? "Direct message",
        groupPath: null,
      });
      setInboxOpen(false);
      setDmPublicId("");
    } catch (caught) {
      show("err", errorMessage(caught));
    }
  }

  async function onSetStorage(event: React.FormEvent) {
    event.preventDefault();
    if (orgPublicId === null) return;
    try {
      await setS3Config({ orgPublicId, ...storageForm });
      show("ok", "Storage connected: new sends upload straight to the org bucket.");
    } catch (caught) {
      show("err", errorMessage(caught));
    }
  }

  async function onUnlock(event: React.FormEvent) {
    event.preventDefault();
    setPinError(null);
    if (await verifyLocalPin(pinInput)) {
      markUnlocked();
      setPinInput("");
      setLocked(false);
    } else {
      setPinError("Wrong PIN");
    }
  }

  async function onSetPin(event: React.FormEvent) {
    event.preventDefault();
    if (pinInput.trim().length < 4) {
      setPinError("Use at least 4 characters");
      return;
    }
    await setLocalPin(pinInput.trim());
    setPinInput("");
    setHasPin(true);
    setPinError(null);
    show("ok", "Local PIN set (a local UI gate — not a second factor).");
  }

  const adminVisible = currentOrg !== null && currentOrg.myOrgRole !== "member";

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand">
            TeamChat <span>v0</span>
          </div>
          <div className="user-chip">
            <strong>{me?.name ?? "…"}</strong>
            <span>{me?.email ?? ""}</span>
            <span>
              {me?.accountState ?? ""} · {currentOrg?.myOrgRole ?? "no org"}
            </span>
          </div>
        </div>

        <div className="sidebar-toolbar">
          <select
            value={orgPublicId ?? ""}
            onChange={(event) => {
              setOrgPublicId(event.target.value === "" ? null : event.target.value);
              setSelected(null);
            }}
            aria-label="Organisation"
          >
            {orgList.length === 0 ? <option value="">No organisations</option> : null}
            {orgList.map((org) => (
              <option key={org.publicId} value={org.publicId}>
                {org.name} ({org.myOrgRole})
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-small" onClick={() => setShowCreateOrg((value) => !value)}>
            New org
          </button>
        </div>

        <div className="sidebar-conn">
          <ConnectionChip />
          <span>reconnect: jittered exponential 1s → 16s</span>
        </div>

        <div className="sidebar-scroll">
          {showCreateOrg || orgList.length === 0 ? (
            <form className="panel panel-body" onSubmit={onCreateOrg} style={{ marginBottom: 8 }}>
              <div className="field">
                <label htmlFor="org-name">New organisation</label>
                <input
                  id="org-name"
                  value={orgName}
                  onChange={(event) => setOrgName(event.target.value)}
                  placeholder="Acme Franchising"
                  required
                />
              </div>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                <input
                  type="checkbox"
                  checked={orgAllowDms}
                  onChange={(event) => setOrgAllowDms(event.target.checked)}
                />
                Allow direct messages in this org
              </label>
              <button className="btn btn-primary btn-small" type="submit" style={{ marginTop: 10 }}>
                Create organisation
              </button>
            </form>
          ) : null}

          {currentOrg !== null ? (
            <div className="panel" style={{ marginBottom: 8 }}>
              <div className="panel-body" style={{ padding: "10px 12px" }}>
                <div style={{ fontWeight: 600 }}>{currentOrg.name}</div>
                <div className="hint" style={{ marginTop: 2 }}>
                  root {currentOrg.rootGroupPublicId ?? "—"} · DMs{" "}
                  {currentOrg.allowDirectMessages ? "allowed" : "disabled"} · storage{" "}
                  {storageState === undefined ? "…" : storageState.provider}
                </div>
              </div>
            </div>
          ) : null}

          <div className="section-title">
            <span>Action</span>
          </div>
          <button
            type="button"
            className={`conv-row${inboxOpen ? " active" : ""}`}
            onClick={() => setInboxOpen(true)}
          >
            <span className="conv-main">
              <span className="conv-name">Action Inbox</span>
              <span className="conv-sub">Rollup · my tasks · tasks I raised · audit</span>
            </span>
            <span className="tag">workflow</span>
          </button>

          <div className="section-title">
            <span>Conversations</span>
            <span>{rows.length}</span>
          </div>
          <div className="conv-list">
            {rows.map((row) => {
              const address: ConversationAddress | null =
                row.kind === "group" && row.publicId !== null
                  ? { kind: "group", publicId: row.publicId }
                  : row.kind === "dm" && row.peerPublicId !== null
                    ? { kind: "dm", peerPublicId: row.peerPublicId }
                    : null;
              const active =
                selected !== null &&
                address !== null &&
                JSON.stringify(address) === JSON.stringify(selected.conversation);
              return (
                <ConversationRowItem
                  key={row.kind === "group" ? `g:${row.publicId}` : `d:${row.peerPublicId}`}
                  row={row as ConversationRow}
                  active={active}
                  onOpen={() => openRow(row as ConversationRow)}
                />
              );
            })}
            {rows.length === 0 ? (
              <p className="hint" style={{ padding: "4px 8px" }}>
                No conversations yet. Create a group below, or join an org with an invite.
              </p>
            ) : null}
          </div>

          {adminVisible ? (
            <details className="panel">
              <summary>Group & invite admin</summary>
              <div className="panel-body">
                <form onSubmit={onCreateGroup}>
                  <div className="field">
                    <label htmlFor="group-name">New flat group</label>
                    <input
                      id="group-name"
                      value={groupName}
                      onChange={(event) => setGroupName(event.target.value)}
                      placeholder="Shift handover"
                      required
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="group-members">Members (publicIds, comma-separated)</label>
                    <input
                      id="group-members"
                      value={groupMembers}
                      onChange={(event) => setGroupMembers(event.target.value)}
                      placeholder="usr_…, usr_…"
                    />
                  </div>
                  <button className="btn btn-primary btn-small" type="submit">
                    Create group (under org root)
                  </button>
                </form>

                <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "14px 0" }} />

                <button type="button" className="btn btn-small" onClick={() => void onCreateInvite()}>
                  Create invite link
                </button>
                {inviteToken !== null ? (
                  <div className="hint" style={{ marginTop: 8, overflowWrap: "anywhere" }}>
                    Token: <code>{inviteToken}</code>
                    <br />
                    <button
                      type="button"
                      className="btn-link"
                      onClick={() => {
                        const link = `${window.location.origin}/?invite=${inviteToken}`;
                        void navigator.clipboard.writeText(link);
                        show("ok", "Invite link copied to the clipboard.");
                      }}
                    >
                      Copy full link
                    </button>
                  </div>
                ) : null}

                <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "14px 0" }} />

                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    checked={currentOrg?.allowDirectMessages ?? false}
                    onChange={(event) => {
                      if (orgPublicId === null) return;
                      void updateOrg({ orgPublicId, allowDirectMessages: event.target.checked })
                        .then(() => show("ok", `Direct messages ${event.target.checked ? "enabled" : "disabled"} for the org.`))
                        .catch((caught: unknown) => show("err", errorMessage(caught)));
                    }}
                  />
                  Allow direct messages (org policy, re-checked on every DM send)
                </label>
              </div>
            </details>
          ) : null}

          {adminVisible && orgPublicId !== null ? (
            <WidgetAdmin
              key={`widget-admin:${orgPublicId}`}
              orgPublicId={orgPublicId}
              rootGroupPublicId={currentOrg?.rootGroupPublicId ?? null}
              onNotice={show}
            />
          ) : null}

          {adminVisible && orgPublicId !== null ? (
            <IntegrationAdmin
              key={`integration-admin:${orgPublicId}`}
              orgPublicId={orgPublicId}
              onNotice={show}
            />
          ) : null}

          {adminVisible && orgPublicId !== null ? (
            <CostAdmin key={`cost-admin:${orgPublicId}`} orgPublicId={orgPublicId} />
          ) : null}

          {adminVisible ? (
            <details className="panel">
              <summary>Connect S3 storage (dev admin)</summary>
              <form className="panel-body" onSubmit={onSetStorage}>
                <div className="field">
                  <label htmlFor="s3-endpoint">Endpoint</label>
                  <input
                    id="s3-endpoint"
                    value={storageForm.endpoint}
                    onChange={(event) => setStorageForm({ ...storageForm, endpoint: event.target.value })}
                    placeholder="https://s3.example.com"
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="s3-bucket">Bucket</label>
                  <input
                    id="s3-bucket"
                    value={storageForm.bucket}
                    onChange={(event) => setStorageForm({ ...storageForm, bucket: event.target.value })}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="s3-region">Region</label>
                  <input
                    id="s3-region"
                    value={storageForm.region}
                    onChange={(event) => setStorageForm({ ...storageForm, region: event.target.value })}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="s3-key-prefix">Key prefix</label>
                  <input
                    id="s3-key-prefix"
                    value={storageForm.keyPrefix}
                    onChange={(event) => setStorageForm({ ...storageForm, keyPrefix: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="s3-pending-prefix">Pending prefix</label>
                  <input
                    id="s3-pending-prefix"
                    value={storageForm.pendingPrefix}
                    onChange={(event) => setStorageForm({ ...storageForm, pendingPrefix: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="s3-access-key">Access key id</label>
                  <input
                    id="s3-access-key"
                    value={storageForm.accessKeyId}
                    onChange={(event) => setStorageForm({ ...storageForm, accessKeyId: event.target.value })}
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label htmlFor="s3-secret">Secret access key</label>
                  <input
                    id="s3-secret"
                    type="password"
                    value={storageForm.secretAccessKey}
                    onChange={(event) => setStorageForm({ ...storageForm, secretAccessKey: event.target.value })}
                    autoComplete="off"
                  />
                </div>
                <button className="btn btn-primary btn-small" type="submit">
                  Save storage config
                </button>
                <p className="hint">
                  The secret is encrypted server-side (AES-GCM, versioned master key) and no
                  client-readable query ever returns it. Dev prefills come from web/.env.local.
                </p>
              </form>
            </details>
          ) : null}

          <details className="panel">
            <summary>People & direct messages</summary>
            <div className="panel-body">
              <form onSubmit={onRequestConnection}>
                <div className="field">
                  <label htmlFor="connection-email">Connect by email</label>
                  <input
                    id="connection-email"
                    type="email"
                    value={connectionEmail}
                    onChange={(event) => setConnectionEmail(event.target.value)}
                    placeholder="teammate@example.com"
                  />
                </div>
                <button className="btn btn-small" type="submit">
                  Send request
                </button>
              </form>

              <div style={{ marginTop: 10 }}>
                {(connections ?? []).map((connection) =>
                  connection.peerPublicId === null ? null : (
                    <div className="list-item" key={`${connection.peerPublicId}:${connection.direction}`}>
                      <span className="who">
                        {connection.peerName ?? "Unknown"}{" "}
                        <span className={`tag${connection.status === "pending" ? " pending" : ""}`}>
                          {connection.status === "pending"
                            ? connection.direction === "incoming"
                              ? "incoming"
                              : "sent"
                            : "connected"}
                        </span>
                      </span>
                      <span style={{ display: "flex", gap: 4 }}>
                        {connection.status === "pending" && connection.direction === "incoming" ? (
                          <button
                            type="button"
                            className="btn btn-small"
                            onClick={() => void onAcceptConnection(connection.peerPublicId as string)}
                          >
                            Accept
                          </button>
                        ) : null}
                        {connection.status === "accepted" ? (
                          <button
                            type="button"
                            className="btn btn-small"
                            onClick={() => void onOpenDm(connection.peerPublicId as string)}
                          >
                            Message
                          </button>
                        ) : null}
                      </span>
                    </div>
                  ),
                )}
                {(connections ?? []).length === 0 ? <p className="hint">No connections yet.</p> : null}
              </div>

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void onOpenDm(dmPublicId);
                }}
                style={{ marginTop: 10 }}
              >
                <div className="field">
                  <label htmlFor="dm-public-id">Open a DM by publicId</label>
                  <input
                    id="dm-public-id"
                    value={dmPublicId}
                    onChange={(event) => setDmPublicId(event.target.value)}
                    placeholder="usr_…"
                  />
                </div>
                <button className="btn btn-small" type="submit">
                  Open DM
                </button>
              </form>
              <p className="hint">
                DM policy: allowed when any shared org allows DMs, or when you share no org (personal
                connection). Never shown in trees, rollups or org-admin lists.
              </p>
            </div>
          </details>

          <details className="panel">
            <summary>Invite token & local unlock</summary>
            <div className="panel-body">
              <form onSubmit={onRedeemInvite}>
                <div className="field">
                  <label htmlFor="invite-input">Redeem an invite token</label>
                  <input
                    id="invite-input"
                    value={inviteInput}
                    onChange={(event) => setInviteInput(event.target.value)}
                    placeholder="paste token"
                  />
                </div>
                <button className="btn btn-small" type="submit">
                  Join organisation
                </button>
              </form>

              <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "14px 0" }} />

              {hasPin ? (
                <>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => {
                      lockLocal();
                      setLocked(true);
                    }}
                  >
                    Lock now
                  </button>{" "}
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => {
                      clearLocalPin();
                      setHasPin(false);
                      show("ok", "Local PIN removed.");
                    }}
                  >
                    Remove PIN
                  </button>
                  <p className="hint">A local UI gate only — not authentication, never sent to the server.</p>
                </>
              ) : (
                <form onSubmit={onSetPin}>
                  <div className="field">
                    <label htmlFor="pin-value">Set a local PIN (min 4 characters)</label>
                    <input
                      id="pin-value"
                      type="password"
                      value={pinInput}
                      onChange={(event) => setPinInput(event.target.value)}
                      placeholder="••••"
                    />
                  </div>
                  <button className="btn btn-small" type="submit">
                    Set PIN
                  </button>
                  {biometricAvailable ? (
                    <p className="hint">A platform authenticator is present (biometric stub only — no credential is checked).</p>
                  ) : null}
                </form>
              )}
            </div>
          </details>

          <div className="section-title">
            <span>Session</span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <a className="btn btn-small" href="/offline">
              Offline cache
            </a>
            <button type="button" className="btn btn-small" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {inboxOpen ? (
        <ActionInbox
          key={`inbox:${orgPublicId ?? "none"}`}
          orgPublicId={orgPublicId}
          rootGroupPublicId={currentOrg?.rootGroupPublicId ?? null}
        />
      ) : selected !== null ? (
        <ConversationView
          key={`${selected.conversation.kind}:${
            selected.conversation.kind === "group"
              ? selected.conversation.publicId
              : selected.conversation.peerPublicId
          }`}
          conversation={selected.conversation}
          label={selected.label}
          groupPath={selected.groupPath}
          orgPublicId={selected.conversation.kind === "group" ? orgPublicId : null}
          myPublicId={me?.publicId ?? ""}
        />
      ) : (
        <div className="empty-chat">
          <div>
            <h2>Pick a conversation</h2>
            <p>
              The list shows a dot when a conversation is unread (two document reads). Hover a row
              to fetch the count on demand (“99+”). Open a conversation to see the live last 15
              messages; older history loads only when you ask for it. The Action Inbox rolls up
              open, claimed, done and closed tasks for the selected group and its descendants.
            </p>
          </div>
        </div>
      )}

      {notice !== null ? (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            maxWidth: 520,
            background: notice.kind === "ok" ? "#0f2b22" : "#2b1214",
            border: `1px solid ${notice.kind === "ok" ? "#1f6f56" : "#7f2a2f"}`,
            color: notice.kind === "ok" ? "#9ff0d2" : "#ffb4b9",
            padding: "9px 14px",
            borderRadius: 10,
            fontSize: 12.5,
            zIndex: 40,
            boxShadow: "0 8px 30px rgba(0,0,0,.35)",
          }}
          onClick={() => setNotice(null)}
        >
          {notice.text}
        </div>
      ) : null}

      {locked ? (
        <div className="lock-overlay">
          <form className="lock-card" onSubmit={onUnlock}>
            <h2>Locked</h2>
            <p>This browser has a local PIN. It gates the UI only; the Convex session is unchanged.</p>
            <input
              type="password"
              value={pinInput}
              onChange={(event) => setPinInput(event.target.value)}
              placeholder="PIN"
              autoFocus
            />
            <button className="btn btn-primary" type="submit" style={{ width: "100%" }}>
              Unlock
            </button>
            <p className="error">{pinError ?? ""}</p>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void signOut()}
              style={{ marginTop: 6 }}
            >
              Sign out instead
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
