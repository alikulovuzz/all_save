export interface DownloadRecord {
  id: number;
  original_url: string;
  telegram_file_id: string;
  telegram_message_id: number;
  chat_id: number;
  media_type: string;
  created_at: Date;
}

export interface QueueItem {
  url: string;
  chatId: number;
  statusMessageId?: number;
  formatId?: string;
  replyTo?: number;
  cacheKey?: string;
}

export interface DownloadResult {
  filePath: string;
  mediaType: "video" | "audio" | "animation" | "document" | "photo";
}

export interface VideoFormat {
  formatId: string;
  resolution: string;
  ext: string;
  filesize?: number;
}
