// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import assert from 'assert';
import {Inject, Injectable} from '@nestjs/common';
import {getDbType, SUPPORT_DB} from '@subql/common';
import {IProjectNetworkConfig} from '@subql/types-core';
import {
  GraphQLModelsRelationsEnums,
  GraphQLRelationsType,
  hashName,
  IndexType,
  METADATA_REGEX,
  MULTI_METADATA_REGEX,
  hexToU8a,
} from '@subql/utils';
import {IndexesOptions, ModelStatic, Op, QueryTypes, Sequelize, Transaction, Utils} from '@subql/x-sequelize';
import {camelCase, flatten, upperFirst} from 'lodash';
import {NodeConfig} from '../configure';
import {getLogger} from '../logger';
import {
  addBlockRangeColumnToIndexes,
  addHistoricalIdIndex,
  addIdAndBlockRangeAttributes,
  addRelationToMap,
  addScopeAndBlockHeightHooks,
  addTagsToForeignKeyMap,
  BTREE_GIST_EXTENSION_EXIST_QUERY,
  camelCaseObjectKey,
  commentConstraintQuery,
  commentTableQuery,
  constraintDeferrableQuery,
  createNotifyTrigger,
  createSchemaTrigger,
  createSchemaTriggerFunction,
  createSendNotificationTriggerFunction,
  createUniqueIndexQuery,
  dropNotifyFunction,
  dropNotifyTrigger,
  getExistedIndexesQuery,
  getFkConstraint,
  getTriggers,
  getVirtualFkTag,
  modelsTypeToModelAttributes,
  SmartTags,
  smartTags,
  syncEnums,
  updateIndexesName,
} from '../utils';
import {modelToTableName} from '../utils/sequelizeUtil';
import {MetadataFactory, MetadataRepo, PoiFactory, PoiFactoryDeprecate, PoiRepo} from './entities';
import {Store} from './store';
import {CacheMetadataModel} from './storeCache';
import {StoreCacheService} from './storeCache/storeCache.service';
import {StoreOperations} from './StoreOperations';
import {ISubqueryProject} from './types';

const logger = getLogger('StoreService');
const NULL_MERKEL_ROOT = hexToU8a('0x00');
const NotifyTriggerManipulationType = [`INSERT`, `DELETE`, `UPDATE`];

type RemovedIndexes = Record<string, IndexesOptions[]>;

interface IndexField {
  entityName: string;
  fieldName: string;
  isUnique: boolean;
  type: string;
}

interface NotifyTriggerPayload {
  triggerName: string;
  eventManipulation: string;
}

class NoInitError extends Error {
  constructor() {
    super('StoreService has not been initialized');
  }
}

@Injectable()
export class StoreService {
  poiRepo?: PoiRepo;
  private removedIndexes: RemovedIndexes = {};
  private _modelIndexedFields?: IndexField[];
  private _modelsRelations?: GraphQLModelsRelationsEnums;
  private _metaDataRepo?: MetadataRepo;
  private _historical?: boolean;
  private _dbType?: SUPPORT_DB;
  private _metadataModel?: CacheMetadataModel;

  // Should be updated each block
  private _blockHeight?: number;
  private _operationStack?: StoreOperations;

  constructor(
    private sequelize: Sequelize,
    private config: NodeConfig,
    readonly storeCache: StoreCacheService,
    @Inject('ISubqueryProject') private subqueryProject: ISubqueryProject<IProjectNetworkConfig>
  ) {}

  private get modelIndexedFields(): IndexField[] {
    assert(this._modelIndexedFields, new NoInitError());
    return this._modelIndexedFields;
  }

  private get modelsRelations(): GraphQLModelsRelationsEnums {
    assert(this._modelsRelations, new NoInitError());
    return this._modelsRelations;
  }

  private get metaDataRepo(): MetadataRepo {
    assert(this._metaDataRepo, new NoInitError());
    return this._metaDataRepo;
  }

  private set operationStack(os: StoreOperations | undefined) {
    this._operationStack = os;
  }

  get operationStack(): StoreOperations | undefined {
    return this._operationStack;
  }

  get blockHeight(): number {
    assert(this._blockHeight, new Error('StoreService.setBlockHeight has not been called'));
    return this._blockHeight;
  }

  get historical(): boolean {
    assert(this._historical !== undefined, new NoInitError());
    return this._historical;
  }

  private get dbType(): SUPPORT_DB {
    assert(this._dbType, new NoInitError());
    return this._dbType;
  }

  private get metadataModel(): CacheMetadataModel {
    assert(this._metadataModel, new NoInitError());
    return this._metadataModel;
  }

  // Initialize tables and data that isnt' specific to the users data
  async initCoreTables(schema: string): Promise<void> {
    if (this.config.proofOfIndex) {
      const usePoiFactory = (await this.useDeprecatePoi(schema)) ? PoiFactoryDeprecate : PoiFactory;
      this.poiRepo = usePoiFactory(this.sequelize, schema);
    }

    this._metaDataRepo = await MetadataFactory(
      this.sequelize,
      schema,
      this.config.multiChain,
      this.subqueryProject.network.chainId
    );

    this._dbType = await getDbType(this.sequelize);

    await this.sequelize.sync();

    this._historical = await this.getHistoricalStateEnabled(schema);
    if (this.historical && this.dbType === SUPPORT_DB.cockRoach) {
      this._historical = false;
      logger.warn(`Historical feature is not supported with ${this.dbType}`);
    }
    logger.info(`Historical state is ${this.historical ? 'enabled' : 'disabled'}`);

    this.storeCache.init(this.historical, this.dbType === SUPPORT_DB.cockRoach, this.metaDataRepo, this.poiRepo);

    this._metadataModel = this.storeCache.metadata;

    this.metadataModel.set('historicalStateEnabled', this.historical);
    this.metadataModel.setIncrement('schemaMigrationCount');
  }

  async init(modelsRelations: GraphQLModelsRelationsEnums, schema: string): Promise<void> {
    this._modelsRelations = modelsRelations;

    try {
      await this.syncSchema(schema, this.config.subscription);
    } catch (e: any) {
      logger.error(e, `Having a problem when syncing schema`);
      process.exit(1);
    }
    try {
      this._modelIndexedFields = await this.getAllIndexFields(schema);
    } catch (e: any) {
      logger.error(e, `Having a problem when get indexed fields`);
      process.exit(1);
    }
  }

  async initHotSchemaReloadQueries(schema: string): Promise<void> {
    if (this.dbType === SUPPORT_DB.cockRoach) {
      logger.warn(`Hot schema reload feature is not supported with ${this.dbType}`);
      return;
    }

    /* These SQL queries are to allow hot-schema reload on query service */
    const schemaTriggerName = hashName(schema, 'schema_trigger', this.metaDataRepo.tableName);
    const schemaTriggers = await getTriggers(this.sequelize, schemaTriggerName);

    try {
      // TODO
      // For now, due to existing channel name over long issue, we will force replace function first
      // We will change this to check with function length in future
      // const schemaFunctions = await getFunctions(this.sequelize,schema,'schema_notification');
      await this.sequelize.query(`${createSchemaTriggerFunction(schema)}`);

      if (schemaTriggers.length === 0) {
        await this.sequelize.query(createSchemaTrigger(schema, this.metaDataRepo.tableName));
      }
    } catch (e) {
      logger.error(`Failed to init Hot schema reload`);
    }
  }

  // eslint-disable-next-line complexity
  async syncSchema(schema: string, useSubscription: boolean): Promise<void> {
    if (useSubscription && this.dbType === SUPPORT_DB.cockRoach) {
      useSubscription = false;
      logger.warn(`Subscription is not support with ${this.dbType}`);
    }

    const enumTypeMap = new Map<string, string>();
    if (this.historical) {
      const [results] = await this.sequelize.query(BTREE_GIST_EXTENSION_EXIST_QUERY);
      if (results.length === 0) {
        throw new Error('Btree_gist extension is required to enable historical data, contact DB admin for support');
      }
    }

    const [indexesResult] = await this.sequelize.query(getExistedIndexesQuery(schema));
    const existedIndexes = indexesResult.map((i) => (i as any).indexname);

    for (const e of this.modelsRelations.enums) {
      await syncEnums(this.sequelize, this.dbType, e, schema, enumTypeMap, logger);
    }
    const extraQueries = [];
    // Function need to create ahead of triggers
    if (useSubscription) {
      extraQueries.push(createSendNotificationTriggerFunction(schema));
    }
    for (const model of this.modelsRelations.models) {
      const attributes = modelsTypeToModelAttributes(model, enumTypeMap);
      const indexes = model.indexes.map(({fields, unique, using}) => ({
        fields: fields.map((field) => Utils.underscoredIf(field, true)),
        unique,
        using,
      }));
      if (indexes.length > this.config.indexCountLimit) {
        throw new Error(`too many indexes on entity ${model.name}`);
      }
      if (this.historical) {
        addIdAndBlockRangeAttributes(attributes);
        addBlockRangeColumnToIndexes(indexes);
        addHistoricalIdIndex(model, indexes);
      }
      // Hash indexes name to ensure within postgres limit
      // Also check with existed indexes for previous logic, if existed index is valid then ignore it.
      // only update index name as it is new index or not found (it is might be an over length index name)
      updateIndexesName(model.name, indexes, existedIndexes as string[]);

      // Update index query for cockroach db
      this.beforeHandleCockroachIndex(schema, model.name, indexes, existedIndexes as string[], extraQueries);

      const sequelizeModel = this.sequelize.define(model.name, attributes, {
        underscored: true,
        comment: model.description,
        freezeTableName: false,
        createdAt: this.config.timestampField,
        updatedAt: this.config.timestampField,
        schema,
        indexes,
      });

      if (this.historical) {
        addScopeAndBlockHeightHooks(sequelizeModel, this._blockHeight);
        // TODO, remove id and block_range constrain, check id manually
        // see https://github.com/subquery/subql/issues/1542
      }

      if (useSubscription) {
        const triggerName = hashName(schema, 'notify_trigger', sequelizeModel.tableName);
        const notifyTriggers = await getTriggers(this.sequelize, triggerName);
        // Triggers not been found
        if (notifyTriggers.length === 0) {
          extraQueries.push(createNotifyTrigger(schema, sequelizeModel.tableName));
        } else {
          this.validateNotifyTriggers(triggerName, notifyTriggers as NotifyTriggerPayload[]);
        }
      } else {
        //TODO: DROP TRIGGER IF EXIST is not valid syntax for cockroach, better check trigger exist at first.
        if (this.dbType !== SUPPORT_DB.cockRoach) {
          extraQueries.push(dropNotifyTrigger(schema, sequelizeModel.tableName));
        }
      }
    }
    // We have to drop the function after all triggers depend on it are removed
    if (!useSubscription && this.dbType !== SUPPORT_DB.cockRoach) {
      extraQueries.push(dropNotifyFunction(schema));
    }

    const foreignKeyMap = new Map<string, Map<string, SmartTags>>();
    for (const relation of this.modelsRelations.relations) {
      const model = this.sequelize.model(relation.from);
      const relatedModel = this.sequelize.model(relation.to);
      if (this.historical) {
        addRelationToMap(relation, foreignKeyMap, model, relatedModel);
        continue;
      }
      switch (relation.type) {
        case 'belongsTo': {
          const rel = model.belongsTo(relatedModel, {foreignKey: relation.foreignKey});
          const fkConstraint = getFkConstraint(rel.source.tableName, rel.foreignKey);
          if (this.dbType !== SUPPORT_DB.cockRoach) {
            extraQueries.push(constraintDeferrableQuery(model.getTableName().toString(), fkConstraint));
          }
          break;
        }
        case 'hasOne': {
          const rel = model.hasOne(relatedModel, {
            foreignKey: relation.foreignKey,
          });
          const fkConstraint = getFkConstraint(rel.target.tableName, rel.foreignKey);
          const tags = smartTags({
            singleForeignFieldName: relation.fieldName,
          });
          extraQueries.push(
            commentConstraintQuery(`"${schema}"."${rel.target.tableName}"`, fkConstraint, tags),
            createUniqueIndexQuery(schema, relatedModel.tableName, relation.foreignKey)
          );
          break;
        }
        case 'hasMany': {
          const rel = model.hasMany(relatedModel, {
            foreignKey: relation.foreignKey,
          });
          const fkConstraint = getFkConstraint(rel.target.tableName, rel.foreignKey);
          const tags = smartTags({
            foreignFieldName: relation.fieldName,
          });
          extraQueries.push(commentConstraintQuery(`"${schema}"."${rel.target.tableName}"`, fkConstraint, tags));

          break;
        }
        default:
          throw new Error('Relation type is not supported');
      }
    }
    foreignKeyMap.forEach((keys, tableName) => {
      const comment = Array.from(keys.values())
        .map((tags) => smartTags(tags, '|'))
        .join('\n');
      const query = commentTableQuery(`"${schema}"."${tableName}"`, comment);
      extraQueries.push(query);
    });

    await this.sequelize.sync();

    for (const query of extraQueries) {
      await this.sequelize.query(query);
    }

    this.afterHandleCockroachIndex();
  }

  private async useDeprecatePoi(schema: string): Promise<boolean> {
    const sql = `SELECT * FROM information_schema.columns WHERE table_schema = ? AND table_name = '_poi' AND column_name = 'projectId'`;
    const [result] = await this.sequelize.query(sql, {replacements: [schema]});
    return !!result.length;
  }

  async getHistoricalStateEnabled(schema: string): Promise<boolean> {
    const {disableHistorical, multiChain} = this.config;

    try {
      const tableRes = await this.sequelize.query<Array<string>>(
        `SELECT table_name FROM information_schema.tables where table_schema='${schema}'`,
        {type: QueryTypes.SELECT}
      );

      const metadataTableNames = flatten(tableRes).filter(
        (value: string) => METADATA_REGEX.test(value) || MULTI_METADATA_REGEX.test(value)
      );

      if (metadataTableNames.length > 1 && !multiChain) {
        logger.error(
          'There are multiple projects in the database schema, if you are trying to multi-chain index use --multi-chain'
        );
        process.exit(1);
      }

      if (metadataTableNames.length === 1) {
        const res = await this.sequelize.query<{key: string; value: boolean | string}>(
          `SELECT key, value FROM "${schema}"."${metadataTableNames[0]}" WHERE (key = 'historicalStateEnabled' OR key = 'genesisHash')`,
          {type: QueryTypes.SELECT}
        );

        const store = res.reduce(function (total, current) {
          total[current.key] = current.value;
          return total;
        }, {} as {[key: string]: string | boolean});

        const useHistorical =
          store.historicalStateEnabled === undefined ? !disableHistorical : (store.historicalStateEnabled as boolean);

        if (useHistorical && multiChain) {
          throw new Error(
            'Historical feature is enabled and not compatible with multi-chain, to multi-chain index clear postgres schema and re-index project using --multichain'
          );
        }
        return useHistorical;
      }
      throw new Error('Metadata table does not exist');
    } catch (e) {
      if (multiChain && !disableHistorical) {
        logger.info('Historical state is not compatible with multi chain indexing, disabling historical..');
        return false;
      }

      // Will trigger on first startup as metadata table doesn't exist
      return !disableHistorical;
    }
  }

  // Sequelize model will generate follow query to create hash indexes
  // Example SQL:  CREATE INDEX "accounts_person_id" ON "polkadot-starter"."accounts" USING hash ("person_id")
  // This will be rejected from cockroach db due to syntax error
  // To avoid this we need to create index manually and add to extraQueries in order to create index in db
  private beforeHandleCockroachIndex(
    schema: string,
    modelName: string,
    indexes: IndexesOptions[],
    existedIndexes: string[],
    extraQueries: string[]
  ): void {
    if (this.dbType !== SUPPORT_DB.cockRoach) {
      return;
    }
    indexes.forEach((index, i) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      if (index.using === IndexType.HASH && !existedIndexes.includes(index.name!)) {
        const cockroachDbIndexQuery = `CREATE INDEX "${index.name}" ON "${schema}"."${modelToTableName(modelName)}"(${
          index.fields
        }) USING HASH;`;
        extraQueries.push(cockroachDbIndexQuery);
        if (this.removedIndexes[modelName] === undefined) {
          this.removedIndexes[modelName] = [];
        }
        this.removedIndexes[modelName].push(indexes[i]);
        delete indexes[i];
      }
    });
  }

  // Due to we have removed hash index, it will be missing from the model, we need temp store it under `this.removedIndexes`
  // And force add back to the model use `afterHandleCockroachIndex()` after db is synced
  private afterHandleCockroachIndex(): void {
    if (this.dbType !== SUPPORT_DB.cockRoach) {
      return;
    }
    const removedIndexes = Object.entries(this.removedIndexes);
    if (removedIndexes.length > 0) {
      for (const [model, indexes] of removedIndexes) {
        const sqModel = this.sequelize.model(model);
        (sqModel as any)._indexes = (sqModel as any)._indexes.concat(indexes);
      }
    }
  }

  private validateNotifyTriggers(triggerName: string, triggers: NotifyTriggerPayload[]): void {
    if (triggers.length !== NotifyTriggerManipulationType.length) {
      throw new Error(
        `Found ${triggers.length} ${triggerName} triggers, expected ${NotifyTriggerManipulationType.length} triggers `
      );
    }
    triggers.map((t) => {
      if (!NotifyTriggerManipulationType.includes(t.eventManipulation)) {
        throw new Error(`Found unexpected trigger ${t.triggerName} with manipulation ${t.eventManipulation}`);
      }
    });
  }

  setBlockHeight(blockHeight: number): void {
    this._blockHeight = blockHeight;
    if (this.config.proofOfIndex) {
      this.operationStack = new StoreOperations(this.modelsRelations.models);
    }
  }

  getOperationMerkleRoot(): Uint8Array {
    if (this.config.proofOfIndex) {
      assert(this.operationStack, new Error('OperationStack is not set, make sure `setBlockHeight` has been called'));
      this.operationStack.makeOperationMerkleTree();
      const merkelRoot = this.operationStack.getOperationMerkleRoot();
      if (merkelRoot === null) {
        return NULL_MERKEL_ROOT;
      }
      return merkelRoot;
    }
    return NULL_MERKEL_ROOT;
  }

  private async getAllIndexFields(schema: string) {
    const fields: IndexField[][] = [];
    for (const entity of this.modelsRelations.models) {
      const model = this.sequelize.model(entity.name);
      const tableFields = await this.packEntityFields(schema, entity.name, model.tableName);
      fields.push(tableFields);
    }
    return flatten(fields);
  }

  private async packEntityFields(schema: string, entity: string, table: string): Promise<IndexField[]> {
    const rows = await this.sequelize.query(
      `select
    '${entity}' as entity_name,
    a.attname as field_name,
    idx.indisunique as is_unique,
    am.amname as type
from
    pg_index idx
    JOIN pg_class cls ON cls.oid=idx.indexrelid
    JOIN pg_class tab ON tab.oid=idx.indrelid
    JOIN pg_am am ON am.oid=cls.relam,
    pg_namespace n,
    pg_attribute a
where
  n.nspname = '${schema}'
  and tab.relname = '${table}'
  and a.attrelid = tab.oid
  and a.attnum = ANY(idx.indkey)
  and not idx.indisprimary
group by
    n.nspname,
    a.attname,
    tab.relname,
    idx.indisunique,
    am.amname`,
      {
        type: QueryTypes.SELECT,
      }
    );
    return rows.map((result) => camelCaseObjectKey(result)) as IndexField[];
  }

  /**
   * rollback db that is newer than ${targetBlockHeight} (exclusive)
   * set metadata
   * since transaction is handled outside, metadata cache flushing and tx is done there.
   * @param targetBlockHeight
   * @param transaction
   */
  async rewind(targetBlockHeight: number, transaction: Transaction): Promise<void> {
    if (!this.historical) {
      throw new Error('Unable to reindex, historical state not enabled');
    }
    // This should only been called from CLI, blockHeight in storeService never been set and is required for`beforeFind` hook
    // Height no need to change for rewind during indexing
    if (this._blockHeight === undefined) {
      this.setBlockHeight(targetBlockHeight);
    }
    for (const model of Object.values(this.sequelize.models)) {
      if ('__block_range' in model.getAttributes()) {
        await batchDeleteAndThenUpdate(this.sequelize, model, transaction, targetBlockHeight);
      }
    }
    this.metadataModel.set('lastProcessedHeight', targetBlockHeight);
    // metadataModel will be flushed in reindex.ts#reindex()
  }

  isIndexed(entity: string, field: string): boolean {
    return (
      this.modelIndexedFields.findIndex(
        (indexField) =>
          upperFirst(camelCase(indexField.entityName)) === entity && camelCase(indexField.fieldName) === field
      ) > -1
    );
  }

  isIndexedHistorical(entity: string, field: string): boolean {
    return (
      this.modelIndexedFields.findIndex(
        (indexField) =>
          upperFirst(camelCase(indexField.entityName)) === entity &&
          camelCase(indexField.fieldName) === field &&
          // With historical indexes are not unique
          (this.historical || indexField.isUnique)
      ) > -1
    );
  }

  getStore(): Store {
    return new Store(this.config, this.storeCache, this);
  }
}

// REMOVE 10,000 record per batch
async function batchDeleteAndThenUpdate(
  sequelize: Sequelize,
  model: ModelStatic<any>,
  transaction: Transaction,
  targetBlockHeight: number,
  batchSize = 10000
): Promise<void> {
  let destroyCompleted = false;
  let updateCompleted = false;
  while (!destroyCompleted || !updateCompleted) {
    try {
      const [numDestroyRows, [numUpdatedRows]] = await Promise.all([
        destroyCompleted
          ? 0
          : model.destroy({
              transaction,
              hooks: false,
              limit: batchSize,
              where: sequelize.where(sequelize.fn('lower', sequelize.col('_block_range')), Op.gt, targetBlockHeight),
            }),
        updateCompleted
          ? [0]
          : model.update(
              {
                __block_range: sequelize.fn('int8range', sequelize.fn('lower', sequelize.col('_block_range')), null),
              },
              {
                transaction,
                limit: batchSize,
                hooks: false,
                where: {
                  [Op.and]: [
                    {
                      __block_range: {
                        [Op.contains]: targetBlockHeight,
                      },
                    },
                    sequelize.where(sequelize.fn('upper', sequelize.col('_block_range')), Op.not, null),
                  ],
                },
              }
            ),
      ]);
      logger.debug(`${model.name} deleted ${numDestroyRows} records, updated ${numUpdatedRows} records`);
      if (numDestroyRows === 0) {
        destroyCompleted = true;
      }
      if (numUpdatedRows === 0) {
        updateCompleted = true;
      }
    } catch (e) {
      throw new Error(`Reindex update model ${model.name} failed, please try to reindex again: ${e}`);
    }
  }
}
