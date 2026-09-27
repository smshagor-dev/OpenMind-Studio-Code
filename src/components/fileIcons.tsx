import { fileIconPath, folderIconPath } from "../services/extensionIconTheme";
import { DEFAULT_ICON, fileIconName, folderIconName } from "./fileIconSpec";
import { ICON_URLS } from "./fileIconUrls";
import { extensionIconUrl, useIconTheme } from "./iconThemes";

function Icon({ url }: { url: string }) {
  return <img className="file-icon" src={url} width={16} height={16} alt="" draggable={false} />;
}

/** The icon of a file for the active icon theme (its language's, or the generic one; never a broken image). */
export function FileTypeIcon({ name }: { name: string }) {
  const theme = useIconTheme();
  if (theme.extension) {
    const path = fileIconPath(theme.extension.model, name, theme.extension.languageOf(name));
    const url = path === null ? null : extensionIconUrl(theme.extension, path);
    if (url !== null) return <Icon url={url} />;
  }
  const key = theme.fileIcons ? fileIconName(name) : DEFAULT_ICON;
  const url = ICON_URLS[key] ?? ICON_URLS[DEFAULT_ICON];
  return url === undefined ? null : <Icon url={url} />;
}

/** The icon of a folder, closed or open; nothing while the active theme has no folder icons. */
export function FolderTypeIcon({ name, open }: { name: string; open: boolean }) {
  const theme = useIconTheme();
  if (theme.extension) {
    const path = folderIconPath(theme.extension.model, name, open);
    const url = path === null ? null : extensionIconUrl(theme.extension, path);
    if (url !== null) return <Icon url={url} />;
  }
  if (!theme.folderIcons) return null;
  const url = ICON_URLS[folderIconName(name, open)] ?? ICON_URLS[folderIconName("", open)];
  if (url === undefined) return null;
  return <Icon url={url} />;
}
