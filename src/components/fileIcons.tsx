import { fileIconName } from "./fileIconSpec";
import { ICON_URLS } from "./fileIconUrls";

export function FileTypeIcon({ name }: { name: string }) {
  const url = ICON_URLS[fileIconName(name)] ?? ICON_URLS.file;
  return <img className="file-icon" src={url} width={16} height={16} alt="" draggable={false} />;
}
