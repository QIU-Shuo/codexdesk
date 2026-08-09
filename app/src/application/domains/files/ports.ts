import type {
  FileEntryView,
  FileReadView,
} from "../../../contracts/views/files";

export interface FileSystemPort {
  readDirectory(directory: string): Promise<FileEntryView[]>;
  readFile(file: string): Promise<FileReadView>;
  readImage(file: string): Promise<string | null>;
}
