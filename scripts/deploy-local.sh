#!/bin/sh
set -eu

SRC="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DST="${DSH_PLUGIN_DST:-${HOME}/.dsh/profiles/desktop/node_modules/dsh-youtube-archive}"

if [ ! -d "$DST" ]; then
  echo "找不到插件安装目录：$DST" >&2
  echo "请先在 DSH 里安装 dsh-youtube-archive，或修改脚本里的 DST。" >&2
  exit 1
fi

mkdir -p "$DST/lib" "$DST/web"

copy_file() {
  src="$1"
  dest="$2"
  if [ "$src" -ef "$dest" ]; then
    return 0
  fi
  cp -f "$src" "$dest"
}

for file in "$SRC"/lib/*.js; do
  copy_file "$file" "$DST/lib/$(basename "$file")"
done
for file in "$SRC"/web/*; do
  copy_file "$file" "$DST/web/$(basename "$file")"
done
for file in package.json README.md; do
  [ -f "$SRC/$file" ] && copy_file "$SRC/$file" "$DST/$file"
done

echo "已同步到：$DST"
echo "下一步：完全退出 DeepSeek Harness（⌘Q）再重新打开。"
echo "Brave 扩展不需要改动。"
