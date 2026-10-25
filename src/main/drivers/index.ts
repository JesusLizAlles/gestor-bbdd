import { MssqlDriver } from './mssql'
import { MysqlDriver } from './mysql'
import type { DbDriver, DriverConnectOptions } from './types'

export type DriverFactory = (opts: DriverConnectOptions) => DbDriver

export const createDriver: DriverFactory = (opts) =>
  opts.config.engine === 'mysql' ? new MysqlDriver(opts) : new MssqlDriver(opts)
