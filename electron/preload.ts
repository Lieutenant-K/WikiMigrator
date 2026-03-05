import { contextBridge, ipcRenderer } from "electron";

export interface ConvertParams {
  accessToken: string;
  parentPageId: string;
  attachPdf: boolean;
  fileBuffers: Array<{ name: string; buffer: ArrayBuffer; size: number }>;
}

export interface MarkerSetupEvent {
  phase: string;
  message: string;
  progress?: number;
  error?: string;
}

export interface ElectronAPI {
  getPages: (token: string) => Promise<{ pages: Array<{ id: string; title: string; icon: string | null }> }>;
  listFiles: (type: string) => Promise<{ files: Array<{ name: string; type: string; size: number; modifiedAt: string; path: string }>; total: number }>;
  readFile: (dir: string, name: string) => Promise<{ name: string; type: string; content: string; size: number; modifiedAt: string } | null>;
  downloadFile: (dir: string, name: string) => Promise<{ buffer: ArrayBuffer; fileName: string } | null>;
  convert: (params: ConvertParams) => Promise<void>;
  onConvertEvent: (callback: (data: unknown) => void) => () => void;
  checkMarker: () => Promise<{ installed: boolean; path?: string; state?: string }>;
  installMarker: () => Promise<{ success: boolean; error?: string; markerSinglePath?: string }>;
  onMarkerSetupEvent: (callback: (data: MarkerSetupEvent) => void) => () => void;
  cancelConvert: () => Promise<{ success: boolean }>;
  selectFiles: () => Promise<Array<{ name: string; buffer: ArrayBuffer; size: number }> | null>;
}

contextBridge.exposeInMainWorld("electronAPI", {
  getPages: (token: string) => ipcRenderer.invoke("get-pages", token),

  listFiles: (type: string) => ipcRenderer.invoke("list-files", type),

  readFile: (dir: string, name: string) => ipcRenderer.invoke("read-file", dir, name),

  downloadFile: (dir: string, name: string) => ipcRenderer.invoke("download-file", dir, name),

  convert: (params: ConvertParams) => ipcRenderer.invoke("convert", params),

  onConvertEvent: (callback: (data: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on("convert-event", handler);
    return () => {
      ipcRenderer.removeListener("convert-event", handler);
    };
  },

  checkMarker: () => ipcRenderer.invoke("check-marker"),

  installMarker: () => ipcRenderer.invoke("install-marker"),

  onMarkerSetupEvent: (callback: (data: MarkerSetupEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: MarkerSetupEvent) => callback(data);
    ipcRenderer.on("marker-setup-event", handler);
    return () => {
      ipcRenderer.removeListener("marker-setup-event", handler);
    };
  },

  cancelConvert: () => ipcRenderer.invoke("cancel-convert"),

  selectFiles: () => ipcRenderer.invoke("select-files"),
} satisfies ElectronAPI);
