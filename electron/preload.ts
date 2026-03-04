import { contextBridge, ipcRenderer } from "electron";

export interface ConvertParams {
  accessToken: string;
  parentPageId: string;
  attachPdf: boolean;
  fileBuffers: Array<{ name: string; buffer: ArrayBuffer; size: number }>;
}

export interface ElectronAPI {
  getPages: (token: string) => Promise<{ pages: Array<{ id: string; title: string; icon: string | null }> }>;
  listFiles: (type: string) => Promise<{ files: Array<{ name: string; type: string; size: number; modifiedAt: string; path: string }>; total: number }>;
  readFile: (dir: string, name: string) => Promise<{ name: string; type: string; content: string; size: number; modifiedAt: string } | null>;
  downloadFile: (dir: string, name: string) => Promise<{ buffer: ArrayBuffer; fileName: string } | null>;
  convert: (params: ConvertParams) => Promise<void>;
  onConvertEvent: (callback: (data: unknown) => void) => () => void;
  checkMarker: () => Promise<{ installed: boolean; path?: string }>;
  installMarker: () => Promise<{ success: boolean; error?: string }>;
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

  selectFiles: () => ipcRenderer.invoke("select-files"),
} satisfies ElectronAPI);
