import { DEFAULT_ICON, fileIconName, folderIconName } from "./fileIconSpec";
import { ICON_URLS } from "./fileIconUrls";
import { useIconTheme } from "./iconThemes";

/** The icon of a file for the active icon theme (its language's, or the generic one; never a broken image). */
export function FileTypeIcon({ name }: { name: string }) {
  const theme = useIconTheme();
  const key = theme.fileIcons ? fileIconName(name) : DEFAULT_ICON;
  const url = ICON_URLS[key] ?? ICON_URLS[DEFAULT_ICON];
  return <img className="file-icon" src={url} width={16} height={16} alt="" draggable={false} />;
}

/** The icon of a folder, closed or open; nothing while the active theme has no folder icons. */
export function FolderTypeIcon({ name, open }: { name: string; open: boolean }) {
  const theme = useIconTheme();
  if (!theme.folderIcons) return null;
  const url = ICON_URLS[folderIconName(name, open)] ?? ICON_URLS[folderIconName("", open)];
  if (url === undefined) return null;
  return <img className="file-icon" src={url} width={16} height={16} alt="" draggable={false} />;
}
