import { readFileSync } from 'fs';
import { join } from 'path';
import packageJSON from '../../../package.json';

const TRIPO_LOGO_PLACEHOLDER = '__TRIPO_LOGO_SRC__';
const TEMPLATE_TEXT_PLACEHOLDERS = {
  toggleServer: '__TOGGLE_SERVER_LABEL__',
  statusLabel: '__STATUS_LABEL__',
  stoppedStatus: '__STOPPED_STATUS__',
  portLabel: '__PORT_LABEL__',
  currentFileLabel: '__CURRENT_FILE_LABEL__',
  progressLabel: '__PROGRESS_LABEL__',
  logsTitle: '__LOGS_TITLE__',
  clearLogs: '__CLEAR_LOGS_LABEL__',
} as const;

type PanelMessages = Record<string, string>;
const I18N_PREFIX = `${packageJSON.name}.`;

type PanelElements = {
  status: HTMLElement;
  port: HTMLElement;
  currentFile: HTMLElement;
  progress: HTMLProgressElement;
  progressValue: HTMLElement;
  logs: HTMLElement;
  toggleServerButton: HTMLButtonElement;
  clearLogsButton: HTMLButtonElement;
};

type BridgeStateSnapshot = {
  serverRunning: boolean;
  connected: boolean;
  clientName: string;
  currentFile: string;
  progress: number;
  logs: string[];
  port: number;
  portInUse: boolean;
};

type PanelInstance = {
  $: PanelElements;
  _lastLogsText: string;
  _serverRunning: boolean;
  _togglePending: boolean;
  refreshState: () => Promise<void>;
  applyState: (state: BridgeStateSnapshot) => void;
  handleToggleServer: () => Promise<void>;
  ensureServerRunning: () => Promise<void>;
};

function loadStaticFile(...parts: string[]) {
  return readFileSync(join(__dirname, '../../../static', ...parts), 'utf8');
}

function loadImageDataUrl(...parts: string[]) {
  const fileBuffer = readFileSync(join(__dirname, '../../../static', ...parts));
  return `data:image/png;base64,${fileBuffer.toString('base64')}`;
}

const fallbackMessages = require(join(__dirname, '../../../i18n/en.js')) as PanelMessages;

function t(key: string, fallback: string) {
  const translated = Editor.I18n.t(`${I18N_PREFIX}${key}`);
  if (translated && translated !== `${I18N_PREFIX}${key}`) {
    return translated;
  }

  return fallbackMessages[key] || fallback;
}

function loadTemplate() {
  return loadStaticFile('template', 'default', 'index.html')
    .replace(TRIPO_LOGO_PLACEHOLDER, loadImageDataUrl('images', 'TripoLogo.png'))
    .replace(TEMPLATE_TEXT_PLACEHOLDERS.toggleServer, t('start_server', 'Start Server'))
    .replace(TEMPLATE_TEXT_PLACEHOLDERS.statusLabel, t('status_label', 'Status'))
    .replace(TEMPLATE_TEXT_PLACEHOLDERS.stoppedStatus, t('status_stopped', 'Stopped'))
    .replace(TEMPLATE_TEXT_PLACEHOLDERS.portLabel, t('port_label', 'Port'))
    .replace(TEMPLATE_TEXT_PLACEHOLDERS.currentFileLabel, t('current_file_label', 'Current File'))
    .replace(TEMPLATE_TEXT_PLACEHOLDERS.progressLabel, t('progress_label', 'Progress'))
    .replace(TEMPLATE_TEXT_PLACEHOLDERS.logsTitle, t('logs_title', 'Logs'))
    .replace(TEMPLATE_TEXT_PLACEHOLDERS.clearLogs, t('clear_logs', 'Clear Logs'));
}

function applyState(this: PanelInstance, state: BridgeStateSnapshot) {
  const progressPercent = Math.round((state.progress || 0) * 100);
  const nextLogsText = (state.logs || []).join('\n');
  let statusState = state.connected ? 'connected' : (state.serverRunning ? 'listening' : 'stopped');
  if (state.portInUse) {
    statusState = 'port-in-use';
  }

  this.$.status.textContent = state.portInUse
    ? t('status_port_in_use', 'Port In Use')
    : (state.connected
      ? t('status_connected', 'Connected')
      : (state.serverRunning ? t('status_listening', 'Listening') : t('status_stopped', 'Stopped')));
  this.$.status.dataset.state = statusState;
  this.$.port.textContent = String(state.port || '');
  this.$.currentFile.textContent = state.currentFile || '-';
  this.$.progress.value = progressPercent;
  this.$.progressValue.textContent = `${progressPercent}%`;
  if (this._lastLogsText !== nextLogsText) {
    this.$.logs.textContent = nextLogsText;
    this.$.logs.scrollTop = this.$.logs.scrollHeight;
    this._lastLogsText = nextLogsText;
  }

  this._serverRunning = !!state.serverRunning && !state.portInUse;
  this.$.toggleServerButton.dataset.intent = this._serverRunning ? 'stop' : 'start';
  this.$.toggleServerButton.textContent = this._serverRunning
    ? t('stop_server', 'Stop Server')
    : t('start_server', 'Start Server');
}

async function refreshState(this: PanelInstance) {
  const state = await Editor.Message.request(packageJSON.name, 'query-state') as BridgeStateSnapshot;
  this.applyState(state);
}

async function ensureServerRunning(this: PanelInstance) {
  await this.refreshState();
  if (this._serverRunning || this._togglePending) {
    return;
  }

  this._togglePending = true;
  this.$.toggleServerButton.disabled = true;

  try {
    await Editor.Message.request(packageJSON.name, 'start-server');
    await this.refreshState();
  } finally {
    this._togglePending = false;
    this.$.toggleServerButton.disabled = false;
  }
}

async function handleToggleServer(this: PanelInstance) {
  if (this._togglePending) {
    return;
  }

  this._togglePending = true;
  this.$.toggleServerButton.disabled = true;

  try {
    const message = this._serverRunning ? 'stop-server' : 'start-server';
    await Editor.Message.request(packageJSON.name, message);
    await this.refreshState();
  } finally {
    this._togglePending = false;
    this.$.toggleServerButton.disabled = false;
  }
}

export = Editor.Panel.define({
  template: loadTemplate(),
  style: loadStaticFile('style', 'default', 'index.css'),

  $: {
    status: '#status',
    port: '#port',
    currentFile: '#current-file',
    progress: '#progress',
    progressValue: '#progress-value',
    logs: '#logs',
    toggleServerButton: '#toggle-server',
    clearLogsButton: '#clear-logs',
  },

  methods: {
    onStateChanged(this: PanelInstance, snapshot: BridgeStateSnapshot) {
      this.applyState(snapshot);
    },
  },

  listeners: {
    show(this: PanelInstance) {
      void this.ensureServerRunning();
    },
    hide() {},
  },

  ready(this: PanelInstance) {
    this.refreshState = refreshState.bind(this);
    this.applyState = applyState.bind(this);
    this._lastLogsText = '';
    this._serverRunning = false;
    this._togglePending = false;

    this.ensureServerRunning = ensureServerRunning.bind(this);
    this.handleToggleServer = handleToggleServer.bind(this);

    this.$.toggleServerButton.addEventListener('confirm', this.handleToggleServer);
    this.$.toggleServerButton.addEventListener('click', this.handleToggleServer);

    this.$.clearLogsButton.addEventListener('click', async () => {
      await Editor.Message.request(packageJSON.name, 'clear-logs');
      await this.refreshState();
    });

    void this.ensureServerRunning();
  },

  beforeClose() {},

  close(this: PanelInstance) {
    this.$.toggleServerButton.removeEventListener('confirm', this.handleToggleServer);
    this.$.toggleServerButton.removeEventListener('click', this.handleToggleServer);
    Editor.Message.request(packageJSON.name, 'stop-server').catch(() => {});
  },
});