import React, { useEffect, useRef, useState } from "react";
import { callApi, createFreighterSigner } from "@zentrixpay/client";
import {
  createFreighterSigner as createWalletSigner,
  expectedNetworkPassphrase,
  expectedX402Network,
} from "../lib/x402Buy.js";
import { explorerTxUrl } from "../lib/stellarExplorer.js";
import type { HttpMethod, PublicApi } from "../api/apis.js";
import {
  DEFAULT_REQUEST_CONTENT_TYPE,
  methodAllowsBody,
  prepareRequestBody,
  REQUEST_CONTENT_TYPES,
  type RequestContentType,
} from "../lib/requestBody.js";
import type { WalletState } from "../hooks/useWalletConnection.js";

interface Props {
  api: PublicApi;
  wallet: WalletState;
  onClose: () => void;
}

interface HeaderRow {
  id: number;
  name: string;
  value: string;
}

const BODY_PLACEHOLDERS: Record<RequestContentType, string> = {
  "application/json": '{"key":"value"}',
  "text/plain": "Any text",
  "application/x-www-form-urlencoded": "key=value&other=1",
  "application/xml": "<request><key>value</key></request>",
};

interface CallResult {
  status: number;
  charged: boolean;
  price: string;
  contentType: string;
  body: unknown;
  explorerUrl?: string;
}

export function TryItModal({ api, wallet, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const nextHeaderId = useRef(1);
  const [method, setMethod] = useState<HttpMethod>(api.allowedMethods[0] ?? "GET");
  const [path, setPath] = useState("/");
  const [body, setBody] = useState("");
  const [contentType, setContentType] = useState<RequestContentType>(DEFAULT_REQUEST_CONTENT_TYPE);
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [result, setResult] = useState<CallResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement;
    dialogRef.current?.focus();
    return () => previousFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sending) {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
        ) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, sending]);

  function addHeader() {
    setHeaders((current) => [...current, { id: nextHeaderId.current++, name: "", value: "" }]);
  }

  function updateHeader(id: number, key: "name" | "value", value: string) {
    setHeaders((current) =>
      current.map((header) => (header.id === id ? { ...header, [key]: value } : header)),
    );
  }

  async function sendRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setResult(null);
    if (!wallet.address) {
      setError("Connect a Stellar wallet before sending a paid request.");
      return;
    }

    let requestHeaders: Record<string, string>;
    try {
      const parsed = new Headers();
      for (const header of headers) {
        if (header.name.trim()) parsed.set(header.name.trim(), header.value);
      }
      requestHeaders = Object.fromEntries(parsed.entries());
    } catch (err) {
      setError(err instanceof Error ? err.message : "A request header is invalid.");
      return;
    }

    // Checked before paying, so a malformed body never costs a call.
    const prepared = prepareRequestBody(method, contentType, body, requestHeaders);
    if (!prepared.ok) {
      setError(prepared.error);
      return;
    }

    setSending(true);
    try {
      const response = await callApi(api.proxyUrl, {
        signer: createFreighterSigner(
          createWalletSigner(wallet.address, expectedNetworkPassphrase()),
        ),
        network: expectedX402Network(),
        method,
        path,
        body: prepared.body,
        headers: prepared.headers,
      });
      const transaction = response.payment?.transaction;
      setResult({
        status: response.status,
        charged: response.status < 400 && Boolean(response.payment),
        price: api.price,
        contentType: response.headers["content-type"] ?? "",
        body: response.body,
        explorerUrl: transaction ? explorerTxUrl(transaction) : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The request failed.");
    } finally {
      setSending(false);
    }
  }

  const formattedBody =
    result === null
      ? ""
      : typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body, null, 2);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget && !sending) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="try-it-title"
        tabIndex={-1}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl outline-none dark:bg-gray-800"
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h2
              id="try-it-title"
              className="text-lg font-semibold text-gray-900 dark:text-gray-100"
            >
              Try {api.name}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">{api.price} USDC per call</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={sending}
            onClick={onClose}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-700"
          >
            ×
          </button>
        </div>

        <form onSubmit={sendRequest} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_1fr]">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">
              Method
              <select
                value={method}
                onChange={(event) => setMethod(event.target.value as HttpMethod)}
                className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
              >
                {api.allowedMethods.map((allowedMethod) => (
                  <option key={allowedMethod} value={allowedMethod}>
                    {allowedMethod}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-200">
              Path and query
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                required
                className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono dark:border-gray-600 dark:bg-gray-900"
                placeholder="/v1/resource"
              />
            </label>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-gray-800 dark:text-gray-100">
              Request headers
            </legend>
            {headers.map((header, index) => (
              <div key={header.id} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <label className="sr-only" htmlFor={`try-header-name-${header.id}`}>
                  Header name {index + 1}
                </label>
                <input
                  id={`try-header-name-${header.id}`}
                  value={header.name}
                  onChange={(event) => updateHeader(header.id, "name", event.target.value)}
                  placeholder="Header name"
                  className="min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm dark:border-gray-600 dark:bg-gray-900"
                />
                <label className="sr-only" htmlFor={`try-header-value-${header.id}`}>
                  Header value {index + 1}
                </label>
                <input
                  id={`try-header-value-${header.id}`}
                  value={header.value}
                  onChange={(event) => updateHeader(header.id, "value", event.target.value)}
                  placeholder="Header value"
                  className="min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
                />
                <button
                  type="button"
                  aria-label={`Remove header ${index + 1}`}
                  onClick={() =>
                    setHeaders((current) => current.filter((item) => item.id !== header.id))
                  }
                  className="rounded-lg border border-gray-300 px-3 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addHeader}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Add header
            </button>
          </fieldset>

          {methodAllowsBody(method) ? (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
                Content type
                <select
                  value={contentType}
                  onChange={(event) => setContentType(event.target.value as RequestContentType)}
                  className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-900 sm:w-64"
                >
                  {REQUEST_CONTENT_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label} ({type.value})
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
                Request body
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={5}
                  aria-describedby="try-body-hint"
                  className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm dark:border-gray-600 dark:bg-gray-900"
                  placeholder={BODY_PLACEHOLDERS[contentType]}
                />
              </label>
              <p id="try-body-hint" className="text-xs text-gray-500 dark:text-gray-400">
                Sent exactly as typed. A Content-Type set under request headers overrides this
                choice. Leave empty to send no body.
              </p>
            </div>
          ) : (
            <p className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600 dark:bg-gray-900 dark:text-gray-300">
              GET requests are sent without a body. Put parameters in the path and query.
            </p>
          )}

          {wallet.status !== "connected" && (
            <div className="flex items-center justify-between gap-3 text-sm text-amber-700 dark:text-amber-300">
              <span>{wallet.error ?? "Connect your Stellar wallet to pay for this call."}</span>
              <button type="button" onClick={() => void wallet.connect()} className="underline">
                Connect wallet
              </button>
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
            >
              {error}
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={sending}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"
            >
              {sending ? "Sending…" : "Send request"}
            </button>
          </div>
        </form>

        {result && (
          <section
            aria-label="Response"
            className="mt-5 space-y-3 border-t border-gray-200 pt-4 dark:border-gray-700"
          >
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={`rounded px-2 py-1 text-sm font-semibold ${
                  result.status < 400
                    ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                    : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
                }`}
              >
                {result.status}
              </span>
              <span className="text-sm text-gray-600 dark:text-gray-300">
                {result.charged ? `Charged ${result.price} USDC` : "Not charged"}
              </span>
              {result.explorerUrl && (
                <a
                  href={result.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-indigo-600 underline dark:text-indigo-400"
                >
                  View transaction in explorer
                </a>
              )}
            </div>
            <pre className="max-h-80 overflow-auto rounded-lg bg-gray-100 p-3 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-100">
              {formattedBody}
            </pre>
          </section>
        )}
      </div>
    </div>
  );
}
