// Hook afterSign de electron-builder: vuelve a firmar la app de macOS con un certificado autofirmado.
//
// Con la firma ad-hoc la identidad de la app es la huella del binario, distinta en cada versión, así
// que tras cada actualización macOS la trata como otra app: el llavero vuelve a pedir la contraseña
// para leer «Gestor BBDD Safe Storage». Con un certificado fijo la identidad pasa a ser
// `identifier "com.sethotels.gestorbbdd" and certificate leaf = H"…"`, la misma en todas las versiones.
//
// electron-builder solo admite certificados de Apple o de confianza en el sistema, por eso se firma
// aquí con codesign y no con `mac.identity`. Sin las variables MAC_CERT_P12 (el .p12 en base64) y
// MAC_CERT_PASSWORD se queda la firma ad-hoc. El certificado se crea con scripts/crear-certificado-mac.sh.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const p12 = process.env.MAC_CERT_P12?.trim()
  const password = process.env.MAC_CERT_PASSWORD ?? ''
  if (!p12) {
    console.log('  • firmar-mac: sin MAC_CERT_P12, se queda la firma ad-hoc')
    return
  }

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const dir = mkdtempSync(join(tmpdir(), 'gestor-bbdd-firma-'))
  const keychain = join(dir, 'firma.keychain-db')
  // La contraseña del llavero temporal no protege nada: el llavero se borra al terminar.
  const keychainPassword = 'firma-temporal'
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  try {
    writeFileSync(join(dir, 'cert.p12'), Buffer.from(p12, 'base64'))
    run('security', ['create-keychain', '-p', keychainPassword, keychain])
    run('security', ['set-keychain-settings', keychain])
    run('security', ['unlock-keychain', '-p', keychainPassword, keychain])
    run('security', ['import', join(dir, 'cert.p12'), '-k', keychain, '-P', password, '-T', '/usr/bin/codesign'])
    // Sin esto codesign pide permiso para usar la clave (y en CI no hay nadie que lo conceda).
    run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', keychainPassword, keychain])

    // Sin `-v`: el certificado autofirmado no es de confianza, pero codesign firma igual con él.
    const identities = run('security', ['find-identity', '-p', 'codesigning', keychain])
    const hash = identities.match(/\b([0-9A-F]{40})\b/)?.[1]
    if (!hash) throw new Error(`firmar-mac: el .p12 no contiene una identidad de firma de código\n${identities}`)

    // --deep firma también los helpers y frameworks de Electron con la misma identidad.
    run('codesign', [
      '--force', '--deep', '--timestamp=none', '--preserve-metadata=entitlements',
      '--sign', hash, '--keychain', keychain, app
    ])
    run('codesign', ['--verify', '--deep', '--strict', app])
    const requirement = execFileSync('codesign', ['-d', '-r-', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    console.log(`  • firmar-mac: firmada con el certificado ${hash}`)
    console.log(`    ${requirement.trim().split('\n').pop()}`)
  } finally {
    try {
      run('security', ['delete-keychain', keychain])
    } catch {
      // Si no llegó a crearse, no hay nada que borrar.
    }
    rmSync(dir, { recursive: true, force: true })
  }
}
