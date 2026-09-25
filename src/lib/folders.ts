export const MAX_FOLDER_NAME_LENGTH = 80;

export function parseFolderName(value: unknown): { name: string; key: string } {
  if (typeof value !== "string" || /\p{Cc}/u.test(value))
    throw new Error("Nom de dossier invalide.");
  const name = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!name || name.length > MAX_FOLDER_NAME_LENGTH)
    throw new Error(
      `Le nom du dossier doit contenir entre 1 et ${MAX_FOLDER_NAME_LENGTH} caractères.`,
    );
  return { name, key: name.toLowerCase().normalize("NFC") };
}
