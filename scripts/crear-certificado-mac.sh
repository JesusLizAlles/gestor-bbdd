#!/usr/bin/env bash
# Crea el certificado autofirmado con el que se firma la app de macOS (ver scripts/firmar-mac.mjs).
# Se genera UNA sola vez y se guarda como secreto del repositorio: si cambia, macOS vuelve a tratar
# la app como otra distinta (el llavero pide de nuevo la contraseña para leer las claves guardadas).
#
# Uso: bash scripts/crear-certificado-mac.sh [carpeta-de-salida]
# Deja en la carpeta gestor-bbdd-mac.p12 y gestor-bbdd-mac.p12.base64, e imprime la contraseña.
# Ninguno de los dos ficheros debe subirse al repositorio.
set -euo pipefail

out=${1:-.}
mkdir -p "$out"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

password=$(openssl rand -base64 24)

# Certificado de firma de código válido 20 años: al caducar habría que cambiarlo y, con él, la identidad.
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 7300 \
  -subj "/CN=Gestor BBDD" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -addext "basicConstraints=critical,CA:false" \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null

# Cifrado 3DES/SHA-1: es el que importa `security` de macOS tanto con LibreSSL como con OpenSSL 3.
openssl pkcs12 -export -name "Gestor BBDD" \
  -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 \
  -passout "pass:$password" -out "$out/gestor-bbdd-mac.p12"

base64 < "$out/gestor-bbdd-mac.p12" | tr -d '\n' > "$out/gestor-bbdd-mac.p12.base64"

cat <<EOF
Certificado creado en $out/gestor-bbdd-mac.p12

Guárdalo en GitHub → Settings → Secrets and variables → Actions como:
  MAC_CERT_P12       contenido de $out/gestor-bbdd-mac.p12.base64
  MAC_CERT_PASSWORD  $password

Guarda también una copia del .p12 y la contraseña fuera del repositorio: sin ellos no se puede
volver a firmar con la misma identidad.
EOF
