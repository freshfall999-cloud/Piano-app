#!/bin/sh
# Run before each release: gives the page's code files a new version name so browsers fetch the new ones.
cd "$(dirname "$0")" && v=$(date +%Y%m%d%H%M) && sed -i -E "s/(style\.css|sound\.js|songs\.js|app\.js|listen-ml\.js|arrange\.js|gate\.js)(\?v=[0-9]+)?\"/\1?v=$v\"/g" index.html && echo "version $v"
