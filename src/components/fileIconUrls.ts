/**
 * The bundled Material Icon Theme SVGs this app uses, by icon name. The list must name exactly the icons in
 * `fileIconSpec.ts` (a test checks it); Vite inlines the small SVGs, so nothing is loaded from the network.
 */
export const ICON_URLS: Record<string, string> = Object.fromEntries(
  Object.entries({
    ...import.meta.glob<string>(
      "../../node_modules/material-icon-theme/icons/{android,astro,audio,babel,bun,c,certificate,claude,cmake,console,cpp,csharp,css,dart,database,deno,dll,docker,document,editorconfig,elixir,erlang,eslint,exe,file,font,fortran,fsharp,gemfile,git,go,go-mod,gradle,graphql,h,haskell,hpp,html,image,java,javascript,jest,json,jupyter,key,kotlin,laravel,less,license,lock,log,lua,makefile,markdown,mdx,nginx,nodejs,npm,pascal,pdf,perl,php,pnpm,powershell,prettier,prisma,proto,python,python-misc,r,react,react_ts,readme,ruby,rust,sass,scala,settings,svelte,svg,swift,table,tauri,terraform,tex,toml,tsconfig,tune,typescript,typescript-def,url,video,vim,vite,vitest,vue,webassembly,webpack,xml,yaml,yarn,zig,zip}.svg",
      { eager: true, query: "?url", import: "default" },
    ),
    ...import.meta.glob<string>(
      "../../node_modules/material-icon-theme/icons/folder-{base,src,src-tauri,test,node,git,github,dist,target,public,resource,routes,controller,components,views,config,docs,lib,app,database,images,scripts,utils,api,android,ios}{,-open}.svg",
      { eager: true, query: "?url", import: "default" },
    ),
  }).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -".svg".length), url]),
);

export function iconUrl(name: string): string | undefined {
  return ICON_URLS[name];
}
