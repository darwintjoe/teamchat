"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

type Scope =
  | "messages:write"
  | "messages:read"
  | "users:provision"
  | "groups:manage"
  | "tasks:read";

const SCOPES: Scope[] = [
  "messages:write",
  "messages:read",
  "users:provision",
  "groups:manage",
  "tasks:read",
];

type ApiKey = {
  publicId: string;
  label: string;
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
  state: "active" | "expired" | "revoked";
};

type Delivery = {
  event: string;
  status: "pending" | "delivered" | "failed" | "dead";
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  createdAt: number;
};

type Webhook = {
  publicId: string;
  url: string;
  events: string[];
  isActive: boolean;
  createdAt: number;
  recentDeliveries: Delivery[];
};

const WEBHOOK_EVENTS = [
  "task.claimed",
  "task.forwarded",
  "task.done",
  "task.reopened",
  "task.closed",
  "message.created",
] as const;

type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

function when(value: number | null): string {
  return value === null ? "never" : new Date(value).toISOString().replace("T", " ").slice(0, 19);
}

export function IntegrationAdmin({
  orgPublicId,
  onNotice,
}: {
  orgPublicId: string;
  onNotice: (kind: "ok" | "err", text: string) => void;
}) {
  return (
    <>
      <ApiKeys orgPublicId={orgPublicId} onNotice={onNotice} />
      <Webhooks orgPublicId={orgPublicId} onNotice={onNotice} />
    </>
  );
}

function ApiKeys({
  orgPublicId,
  onNotice,
}: {
  orgPublicId: string;
  onNotice: (kind: "ok" | "err", text: string) => void;
}) {
  const keys = useQuery(api.apiKeys.listForOrg, { orgPublicId }) as ApiKey[] | undefined;
  const create = useMutation(api.apiKeys.create);
  const revoke = useMutation(api.apiKeys.revoke);
  const rotate = useMutation(api.apiKeys.rotate);
  const setRateLimit = useMutation(api.apiKeys.setRateLimit);

  const [label, setLabel] = useState("ERP integration");
  const [scopes, setScopes] = useState<Scope[]>(["messages:write", "tasks:read"]);
  const [secret, setSecret] = useState<{ publicId: string; key: string } | null>(null);
  const [rate, setRate] = useState(500);

  async function onCreate(event: React.FormEvent) {
    event.preventDefault();
    try {
      const result = await create({ orgPublicId, label: label.trim(), scopes });
      setSecret({ publicId: result.keyPublicId, key: result.key });
      onNotice("ok", `API key ${result.keyPublicId} created. Copy the secret now.`);
    } catch (caught) {
      onNotice("err", errorMessage(caught));
    }
  }

  return (
    <details className="panel">
      <summary>API keys</summary>
      <div className="panel-body">
        <form onSubmit={onCreate}>
          <div className="field">
            <label htmlFor="api-key-label">Label</label>
            <input
              id="api-key-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label>Scopes</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {SCOPES.map((scope) => (
                <label key={scope} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(event) =>
                      setScopes((current) =>
                        event.target.checked
                          ? [...current, scope]
                          : current.filter((value) => value !== scope),
                      )
                    }
                  />
                  {scope}
                </label>
              ))}
            </div>
          </div>
          <button className="btn btn-primary btn-small" type="submit" style={{ marginTop: 10 }}>
            Create key
          </button>
          <p className="hint">
            Format <code>tc_live_</code> + 32 random characters · only a SHA-256 hash is stored ·
            expires 90 days after creation.
          </p>
        </form>

        {secret !== null ? (
          <div className="notice notice-ok" style={{ overflowWrap: "anywhere" }}>
            <strong>Copy this secret now — it is shown once.</strong>
            <div>
              <code>{secret.key}</code>
            </div>
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                void navigator.clipboard.writeText(secret.key);
                onNotice("ok", "API key copied.");
              }}
            >
              Copy secret
            </button>
          </div>
        ) : null}

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "14px 0" }} />

        {(keys ?? []).length === 0 ? <p className="hint">No API keys yet.</p> : null}
        {(keys ?? []).map((key) => (
          <div key={key.publicId} className="panel" style={{ marginTop: 8 }}>
            <div className="panel-body">
              <strong style={{ fontSize: 12.5 }}>{key.label}</strong>
              <p className="hint">
                <code>{key.publicId}</code> · {key.state}
                <br />
                scopes {key.scopes.join(", ")}
                <br />
                last used {when(key.lastUsedAt)} · expires {when(key.expiresAt)}
                {key.rotatedAt === null ? "" : ` · rotated ${when(key.rotatedAt)}`}
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={key.revokedAt !== null}
                  onClick={() => {
                    void rotate({ orgPublicId, keyPublicId: key.publicId })
                      .then((result) => {
                        setSecret({ publicId: result.keyPublicId, key: result.key });
                        onNotice("ok", `Rotated ${key.publicId}; the old key is revoked.`);
                      })
                      .catch((caught: unknown) => onNotice("err", errorMessage(caught)));
                  }}
                >
                  Rotate
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={key.revokedAt !== null}
                  onClick={() => {
                    void revoke({ orgPublicId, keyPublicId: key.publicId })
                      .then(() => onNotice("ok", `Revoked ${key.publicId}.`))
                      .catch((caught: unknown) => onNotice("err", errorMessage(caught)));
                  }}
                >
                  Revoke
                </button>
              </div>
            </div>
          </div>
        ))}

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "14px 0" }} />
        <strong style={{ fontSize: 12.5 }}>Per-key request limit</strong>
        <div style={{ display: "flex", gap: 8, alignItems: "end", marginTop: 6 }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="api-rate">Requests / minute (floor 500)</label>
            <input
              id="api-rate"
              type="number"
              min={500}
              value={rate}
              onChange={(event) => setRate(Number(event.target.value))}
            />
          </div>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              void setRateLimit({ orgPublicId, requestsPerMinute: Number(rate) })
                .then(() => onNotice("ok", `API rate limit set to ${rate}/minute for the org.`))
                .catch((caught: unknown) => onNotice("err", errorMessage(caught)));
            }}
          >
            Save limit
          </button>
        </div>
      </div>
    </details>
  );
}

function Webhooks({
  orgPublicId,
  onNotice,
}: {
  orgPublicId: string;
  onNotice: (kind: "ok" | "err", text: string) => void;
}) {
  const hooks = useQuery(api.webhooks.listForOrg, { orgPublicId }) as Webhook[] | undefined;
  const register = useAction(api.webhooks.register);
  const rotate = useAction(api.webhooks.rotateSecret);
  const setActive = useMutation(api.webhooks.setActive);

  const [url, setUrl] = useState("https://example.com/teamchat-webhook");
  const [events, setEvents] = useState<WebhookEvent[]>([
    "task.claimed",
    "task.done",
    "task.closed",
  ]);
  const [secret, setSecret] = useState<{ publicId: string; secret: string } | null>(null);

  async function onRegister(event: React.FormEvent) {
    event.preventDefault();
    try {
      const result = await register({ orgPublicId, url: url.trim(), events });
      setSecret({ publicId: result.webhookPublicId, secret: result.secret });
      onNotice("ok", `Webhook ${result.webhookPublicId} registered. Copy the secret now.`);
    } catch (caught) {
      onNotice("err", errorMessage(caught));
    }
  }

  return (
    <details className="panel">
      <summary>Outbound webhooks</summary>
      <div className="panel-body">
        <form onSubmit={onRegister}>
          <div className="field">
            <label htmlFor="webhook-url">HTTPS endpoint</label>
            <input
              id="webhook-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://erp.example.com/teamchat-webhook"
              required
            />
          </div>
          <div className="field">
            <label>Events</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {WEBHOOK_EVENTS.map((event) => (
                <label key={event} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    checked={events.includes(event)}
                    onChange={(change) =>
                      setEvents((current) =>
                        change.target.checked
                          ? [...current, event]
                          : current.filter((value) => value !== event),
                      )
                    }
                  />
                  {event}
                </label>
              ))}
            </div>
          </div>
          <button className="btn btn-primary btn-small" type="submit" style={{ marginTop: 10 }}>
            Register webhook
          </button>
          <p className="hint">
            HTTPS only. Private, loopback, link-local and metadata addresses are rejected at
            registration and re-checked before every attempt. No redirects are followed.
          </p>
        </form>

        {secret !== null ? (
          <div className="notice notice-ok" style={{ overflowWrap: "anywhere" }}>
            <strong>Signing secret — shown once, stored encrypted.</strong>
            <div>
              <code>{secret.secret}</code>
            </div>
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                void navigator.clipboard.writeText(secret.secret);
                onNotice("ok", "Webhook signing secret copied.");
              }}
            >
              Copy secret
            </button>
          </div>
        ) : null}

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "14px 0" }} />

        {(hooks ?? []).length === 0 ? <p className="hint">No webhooks registered.</p> : null}
        {(hooks ?? []).map((hook) => (
          <div key={hook.publicId} className="panel" style={{ marginTop: 8 }}>
            <div className="panel-body">
              <strong style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{hook.url}</strong>
              <p className="hint">
                <code>{hook.publicId}</code> · {hook.isActive ? "active" : "disabled"}
                <br />
                {hook.events.join(", ")}
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    void rotate({ orgPublicId, webhookPublicId: hook.publicId })
                      .then((result) => {
                        setSecret({
                          publicId: result.webhookPublicId,
                          secret: result.secret,
                        });
                        onNotice("ok", `Secret rotated for ${hook.publicId}.`);
                      })
                      .catch((caught: unknown) => onNotice("err", errorMessage(caught)));
                  }}
                >
                  Rotate secret
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    void setActive({
                      orgPublicId,
                      webhookPublicId: hook.publicId,
                      isActive: !hook.isActive,
                    })
                      .then(() => onNotice("ok", `${hook.publicId} ${hook.isActive ? "disabled" : "enabled"}.`))
                      .catch((caught: unknown) => onNotice("err", errorMessage(caught)));
                  }}
                >
                  {hook.isActive ? "Disable" : "Enable"}
                </button>
              </div>

              <strong style={{ fontSize: 12.5, display: "block", marginTop: 12 }}>
                Recent deliveries
              </strong>
              {hook.recentDeliveries.length === 0 ? (
                <p className="hint">No deliveries yet.</p>
              ) : (
                hook.recentDeliveries.map((delivery, index) => (
                  <p className="hint" key={`${hook.publicId}:${index}`}>
                    {delivery.event} · {delivery.status} · attempts {delivery.attempts} ·{" "}
                    {when(delivery.createdAt)}
                    {delivery.lastError === null ? "" : ` · ${delivery.lastError}`}
                  </p>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}
