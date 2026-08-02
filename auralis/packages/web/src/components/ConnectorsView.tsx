import { useCallback, useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import {
  createConnector,
  deleteConnector,
  listConnectors,
  testConnector,
  toUserMessage,
} from '../api/client.js';
import type { ConnectorKind, ConnectorSummary } from '../api/types.js';
import { CONNECTOR_KIND_VALUES } from '../api/vocabulary.js';
import { useResource } from '../hooks/useResource.js';
import { formatDateTime } from '../lib/format.js';
import { connectorKindLabel, connectorStatusLabel, connectorStatusTone } from '../lib/labels.js';
import { Notice } from './Notice.js';
import { StatusChip } from './StatusChip.js';

interface FieldSpec {
  readonly key: string;
  readonly label: string;
  readonly placeholder: string;
  readonly secret?: boolean;
  readonly required?: boolean;
  readonly hint?: string;
}

const MASK = '••••••';

const FIELDS: Record<ConnectorKind, readonly FieldSpec[]> = {
  's3-compatible': [
    { key: 'endpoint', label: 'Endpoint', placeholder: 'https://s3.example.com', required: true },
    { key: 'region', label: 'Region', placeholder: 'eu-central-1' },
    { key: 'bucket', label: 'Bucket', placeholder: 'field-recordings', required: true },
    { key: 'prefix', label: 'Folder prefix', placeholder: 'archive/2024' },
    { key: 'accessKeyId', label: 'Access key ID', placeholder: '', secret: true, required: true },
    {
      key: 'secretAccessKey',
      label: 'Secret access key',
      placeholder: '',
      secret: true,
      required: true,
    },
  ],
  webdav: [
    {
      key: 'baseUrl',
      label: 'Address',
      placeholder: 'https://files.example.com/dav',
      required: true,
    },
    { key: 'username', label: 'Username', placeholder: '' },
    { key: 'password', label: 'Password', placeholder: '', secret: true },
  ],
  'custom-json-api': [
    {
      key: 'baseUrl',
      label: 'Address',
      placeholder: 'https://api.example.com/search',
      required: true,
    },
    { key: 'apiKey', label: 'API key', placeholder: '', secret: true },
    {
      key: 'resultsPath',
      label: 'Results field',
      placeholder: 'data.items',
      hint: 'Where the list of results sits in the response.',
    },
  ],
  'rss-feed': [
    {
      key: 'feedUrl',
      label: 'Feed address',
      placeholder: 'https://example.com/feed.xml',
      required: true,
    },
  ],
  'http-directory': [
    {
      key: 'baseUrl',
      label: 'Directory address',
      placeholder: 'https://example.com/audio/',
      required: true,
    },
    { key: 'username', label: 'Username', placeholder: '' },
    { key: 'password', label: 'Password', placeholder: '', secret: true },
  ],
  'ftp-directory': [
    { key: 'host', label: 'Host', placeholder: 'ftp.example.com', required: true },
    { key: 'port', label: 'Port', placeholder: '21' },
    { key: 'path', label: 'Folder', placeholder: '/recordings' },
    { key: 'username', label: 'Username', placeholder: '' },
    { key: 'password', label: 'Password', placeholder: '', secret: true },
  ],
  'local-directory': [
    { key: 'path', label: 'Folder path', placeholder: '/srv/audio', required: true },
  ],
};

function isSecretKey(kind: string, key: string): boolean {
  const specs = FIELDS[kind as ConnectorKind];
  if (!specs) return true;
  return specs.find((spec) => spec.key === key)?.secret === true;
}

export interface ConnectorsViewProps {
  readonly onConnectorsChanged: () => void;
}

export function ConnectorsView({ onConnectorsChanged }: ConnectorsViewProps): ReactElement {
  const baseId = useId();
  const connectors = useResource<readonly ConnectorSummary[]>(
    useCallback((signal: AbortSignal) => listConnectors(signal), []),
    [],
  );

  const [kind, setKind] = useState<ConnectorKind>('s3-compatible');
  const [displayName, setDisplayName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [formNotice, setFormNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [rowMessages, setRowMessages] = useState<Record<string, string>>({});

  const specs = FIELDS[kind];

  const setBusy = (id: string, busy: boolean): void => {
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(null);
    setFormNotice(null);

    if (displayName.trim().length === 0) {
      setFormError('Give this connection a name so you can recognise it later.');
      return;
    }
    const missing = specs.filter(
      (spec) => spec.required && (values[spec.key] ?? '').trim().length === 0,
    );
    if (missing.length > 0) {
      setFormError(`Fill in ${missing.map((spec) => spec.label.toLowerCase()).join(', ')}.`);
      return;
    }

    const config: Record<string, string> = {};
    for (const spec of specs) {
      const value = (values[spec.key] ?? '').trim();
      if (value.length > 0) {
        config[spec.key] = value;
      }
    }

    setSubmitting(true);
    try {
      await createConnector({ kind, displayName: displayName.trim(), config });
      setDisplayName('');
      setValues({});
      setFormNotice('The connection was added.');
      connectors.reload();
      onConnectorsChanged();
    } catch (error) {
      setFormError(toUserMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const handleTest = async (connector: ConnectorSummary): Promise<void> => {
    setBusy(connector.id, true);
    try {
      const outcome = await testConnector(connector.id);
      setRowMessages((current) => ({ ...current, [connector.id]: outcome.message }));
      connectors.reload();
    } catch (error) {
      setRowMessages((current) => ({ ...current, [connector.id]: toUserMessage(error) }));
    } finally {
      setBusy(connector.id, false);
    }
  };

  const handleDelete = async (connector: ConnectorSummary): Promise<void> => {
    setBusy(connector.id, true);
    try {
      await deleteConnector(connector.id);
      connectors.reload();
      onConnectorsChanged();
    } catch (error) {
      setRowMessages((current) => ({ ...current, [connector.id]: toUserMessage(error) }));
    } finally {
      setBusy(connector.id, false);
    }
  };

  return (
    <div className="au-view">
      <header className="au-view__head">
        <h1 className="au-view__title">Connected sources</h1>
        <p className="au-view__lede">
          Connect your own storage, feeds and folders so Auralis can search them alongside open
          archives. Credentials are stored by the engine and never shown again.
        </p>
      </header>

      <section className="au-view__section" aria-labelledby={`${baseId}-list-heading`}>
        <h2 className="au-view__heading" id={`${baseId}-list-heading`}>
          Your connections
        </h2>

        {connectors.status === 'loading' ? <p className="au-hint">Loading connections…</p> : null}

        {connectors.status === 'error' ? (
          <Notice tone="warning" title="Connections could not be loaded">
            <p>{connectors.error ?? 'Try again in a moment.'}</p>
            <p>
              <button type="button" className="au-link-button" onClick={connectors.reload}>
                Try again
              </button>
            </p>
          </Notice>
        ) : null}

        {connectors.status === 'ready' && connectors.data.length === 0 ? (
          <Notice tone="neutral" title="No connections yet">
            <p>Add one below. Until then, Auralis searches only the open sources it ships with.</p>
          </Notice>
        ) : null}

        {connectors.data.length > 0 ? (
          <ul className="au-connectors">
            {connectors.data.map((connector) => {
              const configEntries = Object.entries(connector.config);
              const busy = busyIds.has(connector.id);
              const rowMessage = rowMessages[connector.id];
              return (
                <li key={connector.id} className="au-connector">
                  <div className="au-connector__head">
                    <div>
                      <h3 className="au-connector__name">{connector.displayName}</h3>
                      <p className="au-connector__kind">{connectorKindLabel(connector.kind)}</p>
                    </div>
                    <StatusChip
                      label={connectorStatusLabel(connector.status)}
                      tone={connectorStatusTone(connector.status)}
                      showDot
                    />
                  </div>

                  {connector.status === 'auth_required' ? (
                    <Notice tone="warning" title="Sign-in has expired" compact>
                      <p>This connection needs to be authorised again before it can be searched.</p>
                    </Notice>
                  ) : null}

                  {connector.status === 'not_configured' ? (
                    <Notice tone="warning" title="Configuration needed" compact>
                      <p>Some required settings are missing for this connection.</p>
                    </Notice>
                  ) : null}

                  <p className="au-connector__scope">{connector.scopeDescription}</p>

                  {connector.accountIdentity ? (
                    <p className="au-connector__meta">Account: {connector.accountIdentity}</p>
                  ) : null}

                  {configEntries.length > 0 ? (
                    <div className="au-scroll-x">
                      <table className="au-table">
                        <caption className="au-table__caption">Settings</caption>
                        <tbody>
                          {configEntries.map(([key, value]) => (
                            <tr key={key}>
                              <th scope="row">{key}</th>
                              <td>{isSecretKey(connector.kind, key) ? MASK : value}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  <p className="au-connector__meta">
                    Added {formatDateTime(connector.createdAt) ?? 'recently'}
                    {connector.lastTestedAt
                      ? ` · Last tested ${formatDateTime(connector.lastTestedAt) ?? ''}`
                      : ' · Not tested yet'}
                  </p>

                  {connector.lastTestMessage ? (
                    <p className="au-connector__meta">{connector.lastTestMessage}</p>
                  ) : null}

                  {rowMessage ? (
                    <p className="au-connector__result" role="status">
                      {rowMessage}
                    </p>
                  ) : null}

                  <div className="au-connector__actions">
                    <button
                      type="button"
                      className="au-button"
                      onClick={() => void handleTest(connector)}
                      disabled={busy}
                    >
                      Test connection
                      <span className="au-visually-hidden"> for {connector.displayName}</span>
                    </button>
                    <button
                      type="button"
                      className="au-button au-button--danger"
                      onClick={() => void handleDelete(connector)}
                      disabled={busy}
                    >
                      Disconnect
                      <span className="au-visually-hidden"> {connector.displayName}</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      <section className="au-view__section" aria-labelledby={`${baseId}-add-heading`}>
        <h2 className="au-view__heading" id={`${baseId}-add-heading`}>
          Add a connection
        </h2>

        <form className="au-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
          <div className="au-form__grid">
            <div className="au-field">
              <label className="au-label" htmlFor={`${baseId}-kind`}>
                Kind
              </label>
              <select
                id={`${baseId}-kind`}
                className="au-select"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as ConnectorKind);
                  setValues({});
                  setFormError(null);
                }}
              >
                {CONNECTOR_KIND_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {connectorKindLabel(value)}
                  </option>
                ))}
              </select>
            </div>

            <div className="au-field">
              <label className="au-label" htmlFor={`${baseId}-name`}>
                Name
              </label>
              <input
                id={`${baseId}-name`}
                className="au-input"
                type="text"
                autoComplete="off"
                placeholder="Studio archive"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                aria-describedby={formError ? `${baseId}-form-error` : undefined}
              />
            </div>

            {specs.map((spec) => {
              const fieldId = `${baseId}-${spec.key}`;
              return (
                <div className="au-field" key={spec.key}>
                  <label className="au-label" htmlFor={fieldId}>
                    {spec.label}
                    {spec.required ? '' : ' (optional)'}
                  </label>
                  <input
                    id={fieldId}
                    className="au-input"
                    type={spec.secret ? 'password' : 'text'}
                    autoComplete={spec.secret ? 'new-password' : 'off'}
                    spellCheck={false}
                    placeholder={spec.placeholder}
                    value={values[spec.key] ?? ''}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [spec.key]: event.target.value }))
                    }
                    aria-describedby={spec.hint ? `${fieldId}-hint` : undefined}
                  />
                  {spec.hint ? (
                    <p className="au-hint" id={`${fieldId}-hint`}>
                      {spec.hint}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>

          {formError ? (
            <p className="au-error-text" id={`${baseId}-form-error`} role="alert">
              {formError}
            </p>
          ) : null}
          {formNotice ? (
            <p className="au-form__notice" role="status">
              {formNotice}
            </p>
          ) : null}

          <p className="au-hint">
            Secrets are sent once and stored encrypted by the engine. They are never displayed
            again, only as {MASK}.
          </p>

          <div className="au-form__actions">
            <button type="submit" className="au-button au-button--primary" disabled={submitting}>
              {submitting ? 'Adding…' : 'Add connection'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
