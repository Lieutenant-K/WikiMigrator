import { promises as fs } from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd(), "logs");

export class ConvertLogger {
  private lines: string[] = [];
  private fileName: string;
  private startTime: number;

  constructor(pdfFileName: string) {
    this.startTime = Date.now();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const baseName = pdfFileName.replace(/\.pdf$/i, "");
    this.fileName = `${timestamp}_${baseName}.log`;

    this.info("========================================");
    this.info(`변환 시작: ${pdfFileName}`);
    this.info(`시각: ${new Date().toISOString()}`);
    this.info("========================================");
  }

  private append(level: string, message: string): void {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);
    const line = `[${elapsed}s] [${level}] ${message}`;
    this.lines.push(line);
  }

  info(message: string): void {
    this.append("INFO", message);
  }

  warn(message: string): void {
    this.append("WARN", message);
  }

  error(message: string): void {
    this.append("ERROR", message);
  }

  /** 섹션 구분용 헤더 */
  section(title: string): void {
    this.lines.push("");
    this.append("INFO", `--- ${title} ---`);
  }

  /** 로그 파일을 디스크에 저장 */
  async flush(): Promise<string> {
    const totalElapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);
    this.lines.push("");
    this.append("INFO", "========================================");
    this.append("INFO", `변환 완료: 총 소요 시간 ${totalElapsed}s`);
    this.append("INFO", "========================================");

    await fs.mkdir(LOG_DIR, { recursive: true });
    const logPath = path.join(LOG_DIR, this.fileName);
    await fs.writeFile(logPath, this.lines.join("\n"), "utf-8");
    return logPath;
  }
}
