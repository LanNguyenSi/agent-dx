import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class FileUtils {
  /**
   * Get templates directory path
   */
  static getTemplatesDir(): string {
    return path.join(__dirname, "../../templates");
  }

  /**
   * Copy file with optional transform
   */
  static async copyFile(
    source: string,
    dest: string,
    transform?: (content: string) => string,
  ): Promise<void> {
    await fs.ensureDir(path.dirname(dest));

    if (transform) {
      const content = await fs.readFile(source, "utf-8");
      const transformed = transform(content);
      await fs.writeFile(dest, transformed);
    } else {
      await fs.copy(source, dest);
    }
  }

  /**
   * Copy directory recursively
   */
  static async copyDir(source: string, dest: string): Promise<void> {
    await fs.ensureDir(dest);
    await fs.copy(source, dest);
  }

  /**
   * Write file ensuring directory exists
   */
  static async writeFile(filePath: string, content: string): Promise<void> {
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content);
  }

  /**
   * Read template file
   */
  static async readTemplate(templatePath: string): Promise<string> {
    const fullPath = path.join(this.getTemplatesDir(), templatePath);
    return await fs.readFile(fullPath, "utf-8");
  }

  /**
   * Check if directory exists and is empty
   */
  static async isDirEmpty(dirPath: string): Promise<boolean> {
    try {
      const files = await fs.readdir(dirPath);
      return files.length === 0;
    } catch {
      return true; // Directory doesn't exist, so it's "empty"
    }
  }

  /**
   * Ensure directory exists
   */
  static async ensureDir(dirPath: string): Promise<void> {
    await fs.ensureDir(dirPath);
  }
}
