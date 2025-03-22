import crypto from 'node:crypto'
import path from 'node:path'
import {homedir} from 'os'
import {readFile, writeFile} from 'fs/promises'

export const defaultConfigPath = path.join(homedir(), '.api-client-config')

export type ConfigEntry = {
  token: string
  username: string
 }

export type ClientConfig = {
  'api.heroku.com': ConfigEntry,
  'git.heroku.com': ConfigEntry,
  [machineId: string]: ConfigEntry
}

/**
 * Reads the contents of the config file and decrypts it using the provided bearer token
 * and returns the JSON contents of the config file.
 *
 * @param token the bearer token to use for encryption
 * @param configPath the path to the config file to write
 * @returns a promise that resolves to the JSON contents of the config file
 */
export async function getConfigContents(token: string, configPath: string = defaultConfigPath): Promise<ClientConfig> {
  const encryptedContents = await readFile(configPath, 'utf8')
  const jsonString = await decryptWithToken(encryptedContents, token) ?? '{}'

  return JSON.parse(jsonString)
}

/**
 * Writes the provided contents to the config file and encrypts it using the provided bearer token.
 *
 * @param contents the content to write to the config file. This must be a JSON serializable object
 * @param token the bearer token to use for encryption
 * @param configPath the path to the config file to write
 * @returns a promise that resolves when the config file has been written
 */
export async function writeConfigContents(contents: unknown, token: string, configPath: string = defaultConfigPath): Promise<void> {
  const jsonString = JSON.stringify(contents)
  const encryptedContents = await encryptWithToken(jsonString, token)

  await writeFile(configPath, encryptedContents, 'utf8')
}

/**
 * Encrypts the given content using the provided bearer token.
 * The encrypted content is returned as a string in the format:
 * salt:iv:authTag:encryptedContent
 *
 * IMPORTANT: if the bearer token is revoked, the encrypted data is
 * intentionally not recoverable. This is a security feature to prevent
 * the data from being read after the bearer token is revoked. This
 * is a deliberate and intentional feature of this encryption strategy and must be
 * maintained in order to ensure the data is permanently linked to a
 * revokable object and cannot be read by any other software system.
 *
 * @param content The content to encrypt represented as a string. Binary data must be base64 encoded first
 * @param bearerToken The bearer token to use for encryption. This must be provided as a revokable bearer token
 * @returns the encrypted content as a string
 */
function encryptWithToken(content: string, bearerToken: string): string {
  // Always generate a new random salt for each encryption
  // do not reuse for any reason
  const salt = crypto.randomBytes(16)

  // Derive the key using the salt and bearer token
  // so we guarantee the encrypted data is permanently
  // bound to a revokable object.
  const derivedKey = deriveKey(bearerToken, salt)

  // Generate IV for AES encryption
  // based on industry standards
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv)

  let encrypted = cipher.update(content, 'utf8', 'hex')
  encrypted += cipher.final('hex')

  const authTag = cipher.getAuthTag()

  // Clear from memory (best practice)
  derivedKey.fill(0)

  // Format: salt:iv:authTag:encryptedContent - do not change without also
  // updating the decryptWithToken splits
  return `${salt.toString('hex')}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`
}

/**
 * Derives a key using the provided bearer token and salt.
 * This function is critical to ensuring the key is permanently
 * bound to a unique bearer token obtained via secure authentication
 * flows. If the bearer token is revoked, the encrypted data is
 * intentionally not recoverable.
 *
 * @param bearerToken The bearer token to use for encryption. This must be provided as a revokable bearer token
 * @param salt The salt to use for key derivation. This must be a buffer of 16 bytes
 * @returns the derived key as a buffer
 */
export function deriveKey(bearerToken: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    bearerToken,
    salt,
    100000,
    32,
    'sha512',
  )
}

/**
 * Decrypts the given encrypted content using the provided bearer token.
 * The encrypted content is expected to be in the format:
 * salt:iv:authTag:encryptedContent
 *
 * @param encrypted the content to decrypt
 * @param bearerToken the bearer token to use for decryption
 * @returns the decrypted content as a string
 */
export function decryptWithToken(encrypted: string, bearerToken: string): string {
  // Split all components
  const [saltHex, ivHex, authTagHex, encryptedContent] = encrypted.split(':')

  // Convert components from hex
  const salt = Buffer.from(saltHex, 'hex')
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')

  // Derive the same key using stored salt
  const derivedKey = deriveKey(bearerToken, salt)

  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv)
  decipher.setAuthTag(authTag)

  let decrypted = decipher.update(encryptedContent, 'hex', 'utf8')
  decrypted += decipher.final('utf8')

  // Clear from memory (best practice)
  derivedKey.fill(0)

  return decrypted
}
