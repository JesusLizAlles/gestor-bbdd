import { MssqlDriver } from './mssql'
import { MysqlDriver } from './mysql'
import { PostgresDriver } from './postgres'
import type { DbDriver, DriverConnectOptions } from './types'

export type DriverFactory = (opts: DriverConnectOptions) => DbDriver

export const createDriver: DriverFactory = (opts) => {
  switch (opts.config.engine) {
    case 'mysql':
      return new MysqlDriver(opts)
    case 'mssql':
      return new MssqlDriver(opts)
    case 'postgres':
      return new PostgresDriver(opts)
  }
}
