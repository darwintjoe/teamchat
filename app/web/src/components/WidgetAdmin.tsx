"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

type HostApp = {
  publicId: string;
  name: string;
  issuer: string;
  audience: string;
  allowedOrigins: string[];
  supportGroupPublicId: string | null;
  isActive: boolean;
  primaryColor: string | null;
  logoUrl: string | null;
  allowWidgetUploads: boolean;
  widgetUploadMaxBytes: number | null;
  widgetUploadMimes: string[];
  widgetUploadRatePerMinute: number | null;
  keys: Array<{ kid: string; alg: "ES256" | "RS256"; publicKey: string; notBefore: number; notAfter: number | null }>;
};

const DEFAULT_MIMES = "image/png,image/jpeg,application/pdf,text/plain";

export function WidgetAdmin({
  orgPublicId,
  rootGroupPublicId,
  onNotice,
}: {
  orgPublicId: string;
  rootGroupPublicId: string | null;
  onNotice: (kind: "ok" | "err", text: string) => void;
}) {
  const apps = useQuery(api.hostApps.listForOrg, { orgPublicId }) as HostApp[] | undefined;
  const register = useMutation(api.hostApps.register);
  const addKey = useMutation(api.hostApps.addKey);
  const setBranding = useMutation(api.hostApps.setBranding);
  const configureUploads = useMutation(api.hostApps.configureUploads);
  const setActive = useMutation(api.hostApps.setActive);

  const [form, setForm] = useState({
    name: "Support widget",
    issuer: "https://host.example",
    audience: "teamchat-widget",
    origins: "http://localhost:4310",
    supportGroupPublicId: rootGroupPublicId ?? "",
    primaryColor: "#2563eb",
    logoUrl: "",
    uploads: false,
    maxFileBytes: 2 * 1024 * 1024,
    mimes: DEFAULT_MIMES,
    maxPerMinute: 10,
  });
  const [keyForms, setKeyForms] = useState<Record<string, { kid: string; alg: "ES256" | "RS256"; publicKey: string }>>({});
  const [uploadForms, setUploadForms] = useState<Record<string, { enabled: boolean; maxFileBytes: number; mimes: string; maxPerMinute: number }>>({});

  async function onRegister(event: React.FormEvent) {
    event.preventDefault();
    try {
      const result = await register({
        orgPublicId,
        name: form.name.trim(),
        issuer: form.issuer.trim(),
        audience: form.audience.trim(),
        allowedOrigins: form.origins.split(",").map((value) => value.trim()).filter((value) => value !== ""),
        supportGroupPublicId: form.supportGroupPublicId.trim() || rootGroupPublicId || "",
        primaryColor: form.primaryColor,
        logoUrl: form.logoUrl.trim() === "" ? undefined : form.logoUrl.trim(),
        uploads: form.uploads
          ? {
              allowWidgetUploads: true,
              maxFileBytes: Number(form.maxFileBytes),
              allowedMimes: form.mimes.split(",").map((value) => value.trim()).filter((value) => value !== ""),
              maxPerMinute: Number(form.maxPerMinute),
            }
          : undefined,
      });
      onNotice("ok", `Host app ${result.hostAppPublicId} registered. Add a public key next.`);
    } catch (caught) {
      onNotice("err", errorMessage(caught));
    }
  }

  async function onAddKey(hostAppPublicId: string) {
    const entry = keyForms[hostAppPublicId];
    if (entry === undefined) return;
    try {
      await addKey({
        hostAppPublicId,
        kid: entry.kid.trim(),
        alg: entry.alg,
        publicKey: entry.publicKey.trim(),
      });
      onNotice("ok", `Public key "${entry.kid}" added. Private material is refused.`);
      setKeyForms({ ...keyForms, [hostAppPublicId]: { ...entry, kid: "", publicKey: "" } });
    } catch (caught) {
      onNotice("err", errorMessage(caught));
    }
  }

  async function onUploads(hostAppPublicId: string, current: HostApp) {
    const entry = uploadForms[hostAppPublicId] ?? {
      enabled: current.allowWidgetUploads,
      maxFileBytes: current.widgetUploadMaxBytes ?? 2 * 1024 * 1024,
      mimes: current.widgetUploadMimes.length > 0 ? current.widgetUploadMimes.join(",") : DEFAULT_MIMES,
      maxPerMinute: current.widgetUploadRatePerMinute ?? 10,
    };
    try {
      await configureUploads({
        hostAppPublicId,
        allowWidgetUploads: entry.enabled,
        maxFileBytes: Number(entry.maxFileBytes),
        allowedMimes: entry.mimes.split(",").map((value) => value.trim()).filter((value) => value !== ""),
        maxPerMinute: Number(entry.maxPerMinute),
      });
      onNotice("ok", `Widget uploads ${entry.enabled ? "enabled" : "disabled"} for ${current.name}.`);
    } catch (caught) {
      onNotice("err", errorMessage(caught));
    }
  }

  return (
    <details className="panel">
      <summary>Embedded widget host apps</summary>
      <div className="panel-body">
        <form onSubmit={onRegister}>
          <div className="field">
            <label htmlFor="hap-name">Host app name</label>
            <input id="hap-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="hap-issuer">Issuer (iss)</label>
            <input id="hap-issuer" value={form.issuer} onChange={(event) => setForm({ ...form, issuer: event.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="hap-audience">Audience (aud)</label>
            <input id="hap-audience" value={form.audience} onChange={(event) => setForm({ ...form, audience: event.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="hap-origins">Allowed iframe origins (comma-separated)</label>
            <input id="hap-origins" value={form.origins} onChange={(event) => setForm({ ...form, origins: event.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="hap-group">Support group publicId</label>
            <input
              id="hap-group"
              value={form.supportGroupPublicId}
              onChange={(event) => setForm({ ...form, supportGroupPublicId: event.target.value })}
              placeholder={rootGroupPublicId ?? "grp_…"}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="hap-color">Brand colour (#rrggbb)</label>
            <input id="hap-color" value={form.primaryColor} onChange={(event) => setForm({ ...form, primaryColor: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="hap-logo">Logo URL (optional, http(s))</label>
            <input id="hap-logo" value={form.logoUrl} onChange={(event) => setForm({ ...form, logoUrl: event.target.value })} />
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
            <input type="checkbox" checked={form.uploads} onChange={(event) => setForm({ ...form, uploads: event.target.checked })} />
            Allow widget uploads (opt-in; off by default)
          </label>
          {form.uploads ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
              <div className="field">
                <label htmlFor="hap-max-bytes">Max file bytes</label>
                <input id="hap-max-bytes" type="number" value={form.maxFileBytes} onChange={(event) => setForm({ ...form, maxFileBytes: Number(event.target.value) })} />
              </div>
              <div className="field">
                <label htmlFor="hap-rate">Max uploads/minute</label>
                <input id="hap-rate" type="number" min={1} max={60} value={form.maxPerMinute} onChange={(event) => setForm({ ...form, maxPerMinute: Number(event.target.value) })} />
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label htmlFor="hap-mimes">Allowed MIME types (comma-separated)</label>
                <input id="hap-mimes" value={form.mimes} onChange={(event) => setForm({ ...form, mimes: event.target.value })} />
              </div>
            </div>
          ) : null}
          <button className="btn btn-primary btn-small" type="submit" style={{ marginTop: 10 }}>
            Register host app
          </button>
          <p className="hint">Only public JWKs can be added. There is no shared secret in this trust model.</p>
        </form>

        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "14px 0" }} />

        {(apps ?? []).length === 0 ? <p className="hint">No host apps registered for this organisation.</p> : null}
        {(apps ?? []).map((app) => {
          const keyEntry = keyForms[app.publicId] ?? { kid: "", alg: "ES256" as const, publicKey: "" };
          const uploadEntry =
            uploadForms[app.publicId] ?? {
              enabled: app.allowWidgetUploads,
              maxFileBytes: app.widgetUploadMaxBytes ?? 2 * 1024 * 1024,
              mimes: app.widgetUploadMimes.length > 0 ? app.widgetUploadMimes.join(",") : DEFAULT_MIMES,
              maxPerMinute: app.widgetUploadRatePerMinute ?? 10,
            };
          return (
            <details key={app.publicId} className="panel" style={{ marginTop: 8 }}>
              <summary>
                {app.name} · {app.publicId} {app.isActive ? "" : "(inactive)"}
              </summary>
              <div className="panel-body">
                <p className="hint">
                  iss <code>{app.issuer}</code> · aud <code>{app.audience}</code>
                  <br />
                  origins {app.allowedOrigins.join(", ")} · support {app.supportGroupPublicId ?? "missing"}
                  <br />
                  uploads {app.allowWidgetUploads ? "on" : "off"} · branding {app.primaryColor ?? "default"}
                </p>

                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    void setActive({ hostAppPublicId: app.publicId, isActive: !app.isActive })
                      .then(() => onNotice("ok", `${app.name} ${app.isActive ? "deactivated" : "activated"}.`))
                      .catch((caught: unknown) => onNotice("err", errorMessage(caught)));
                  }}
                >
                  {app.isActive ? "Deactivate" : "Activate"}
                </button>

                <div style={{ marginTop: 10 }}>
                  <strong style={{ fontSize: 12.5 }}>Public keys</strong>
                  {app.keys.length === 0 ? <p className="hint">No keys yet — exchange will refuse every token.</p> : null}
                  {app.keys.map((key) => (
                    <p className="hint" key={key.kid} style={{ overflowWrap: "anywhere" }}>
                      <code>{key.kid}</code> · {key.alg} · {key.notAfter === null ? "no notAfter" : `notAfter ${new Date(key.notAfter).toISOString()}`}
                    </p>
                  ))}
                  <div className="field">
                    <label htmlFor={`kid-${app.publicId}`}>Key id</label>
                    <input
                      id={`kid-${app.publicId}`}
                      value={keyEntry.kid}
                      onChange={(event) => setKeyForms({ ...keyForms, [app.publicId]: { ...keyEntry, kid: event.target.value } })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`alg-${app.publicId}`}>Algorithm</label>
                    <select
                      id={`alg-${app.publicId}`}
                      value={keyEntry.alg}
                      onChange={(event) =>
                        setKeyForms({ ...keyForms, [app.publicId]: { ...keyEntry, alg: event.target.value as "ES256" | "RS256" } })
                      }
                    >
                      <option value="ES256">ES256 (P-256)</option>
                      <option value="RS256">RS256 (RSA)</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor={`jwk-${app.publicId}`}>Public JWK (JSON)</label>
                    <textarea
                      id={`jwk-${app.publicId}`}
                      rows={3}
                      value={keyEntry.publicKey}
                      onChange={(event) => setKeyForms({ ...keyForms, [app.publicId]: { ...keyEntry, publicKey: event.target.value } })}
                      placeholder='{"kty":"EC","crv":"P-256","x":"…","y":"…"}'
                    />
                  </div>
                  <button type="button" className="btn btn-small" onClick={() => void onAddKey(app.publicId)}>
                    Add public key
                  </button>
                </div>

                <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "14px 0" }} />

                <strong style={{ fontSize: 12.5 }}>Uploads</strong>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, marginTop: 6 }}>
                  <input
                    type="checkbox"
                    checked={uploadEntry.enabled}
                    onChange={(event) =>
                      setUploadForms({ ...uploadForms, [app.publicId]: { ...uploadEntry, enabled: event.target.checked } })
                    }
                  />
                  Opt in to widget uploads
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div className="field">
                    <label htmlFor={`bytes-${app.publicId}`}>Max bytes</label>
                    <input
                      id={`bytes-${app.publicId}`}
                      type="number"
                      value={uploadEntry.maxFileBytes}
                      onChange={(event) =>
                        setUploadForms({ ...uploadForms, [app.publicId]: { ...uploadEntry, maxFileBytes: Number(event.target.value) } })
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`rate-${app.publicId}`}>Per minute</label>
                    <input
                      id={`rate-${app.publicId}`}
                      type="number"
                      min={1}
                      max={60}
                      value={uploadEntry.maxPerMinute}
                      onChange={(event) =>
                        setUploadForms({ ...uploadForms, [app.publicId]: { ...uploadEntry, maxPerMinute: Number(event.target.value) } })
                      }
                    />
                  </div>
                  <div className="field" style={{ gridColumn: "1 / -1" }}>
                    <label htmlFor={`mimes-${app.publicId}`}>MIME types</label>
                    <input
                      id={`mimes-${app.publicId}`}
                      value={uploadEntry.mimes}
                      onChange={(event) => setUploadForms({ ...uploadForms, [app.publicId]: { ...uploadEntry, mimes: event.target.value } })}
                    />
                  </div>
                </div>
                <button type="button" className="btn btn-small" onClick={() => void onUploads(app.publicId, app)}>
                  Save upload policy
                </button>

                <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "14px 0" }} />

                <strong style={{ fontSize: 12.5 }}>Branding</strong>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div className="field">
                    <label htmlFor={`color-${app.publicId}`}>Primary colour</label>
                    <input
                      id={`color-${app.publicId}`}
                      value={uploadEntry.enabled ? (app.primaryColor ?? "#2563eb") : (app.primaryColor ?? "#2563eb")}
                      onChange={() => undefined}
                      readOnly
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`logo-${app.publicId}`}>Logo URL</label>
                    <input id={`logo-${app.publicId}`} value={app.logoUrl ?? ""} readOnly />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => {
                      const color = window.prompt("Brand colour (#rrggbb)", app.primaryColor ?? "#2563eb");
                      if (color === null) return;
                      void setBranding({ hostAppPublicId: app.publicId, primaryColor: color, logoUrl: app.logoUrl ?? "" })
                        .then(() => onNotice("ok", `Branding updated for ${app.name}.`))
                        .catch((caught: unknown) => onNotice("err", errorMessage(caught)));
                    }}
                  >
                    Set colour
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => {
                      const logo = window.prompt("Logo URL (blank to clear)", app.logoUrl ?? "");
                      if (logo === null) return;
                      void setBranding({ hostAppPublicId: app.publicId, primaryColor: app.primaryColor ?? "#2563eb", logoUrl: logo })
                        .then(() => onNotice("ok", `Logo updated for ${app.name}.`))
                        .catch((caught: unknown) => onNotice("err", errorMessage(caught)));
                    }}
                  >
                    Set logo
                  </button>
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </details>
  );
}
