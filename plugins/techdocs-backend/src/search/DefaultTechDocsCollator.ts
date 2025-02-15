/*
 * Copyright 2021 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  PluginEndpointDiscovery,
  TokenManager,
} from '@backstage/backend-common';
import {
  Entity,
  RELATION_OWNED_BY,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import { DocumentCollator } from '@backstage/search-common';
import fetch from 'node-fetch';
import unescape from 'lodash/unescape';
import { Logger } from 'winston';
import pLimit from 'p-limit';
import { Config } from '@backstage/config';
import { catalogEntityReadPermission } from '@backstage/plugin-catalog-common';
import { CatalogApi, CatalogClient } from '@backstage/catalog-client';
import { TechDocsDocument } from '@backstage/techdocs-common';

interface MkSearchIndexDoc {
  title: string;
  text: string;
  location: string;
}

/**
 * Options to configure the TechDocs collator
 *
 * @public
 */
export type TechDocsCollatorOptions = {
  discovery: PluginEndpointDiscovery;
  logger: Logger;
  tokenManager: TokenManager;
  locationTemplate?: string;
  catalogClient?: CatalogApi;
  parallelismLimit?: number;
  legacyPathCasing?: boolean;
};

type EntityInfo = {
  name: string;
  namespace: string;
  kind: string;
};

/**
 * A search collator responsible for gathering and transforming TechDocs documents.
 *
 * @public
 */
export class DefaultTechDocsCollator implements DocumentCollator {
  public readonly type: string = 'techdocs';
  public readonly visibilityPermission = catalogEntityReadPermission;

  private constructor(
    private readonly legacyPathCasing: boolean,
    private readonly options: TechDocsCollatorOptions,
  ) {}

  static fromConfig(config: Config, options: TechDocsCollatorOptions) {
    const legacyPathCasing =
      config.getOptionalBoolean(
        'techdocs.legacyUseCaseSensitiveTripletPaths',
      ) || false;
    return new DefaultTechDocsCollator(legacyPathCasing, options);
  }

  async execute() {
    const {
      parallelismLimit,
      discovery,
      tokenManager,
      catalogClient,
      locationTemplate,
      logger,
    } = this.options;
    const limit = pLimit(parallelismLimit ?? 10);
    const techDocsBaseUrl = await discovery.getBaseUrl('techdocs');
    const { token } = await tokenManager.getToken();
    const entities = await (
      catalogClient ?? new CatalogClient({ discoveryApi: discovery })
    ).getEntities(
      {
        fields: [
          'kind',
          'namespace',
          'metadata.annotations',
          'metadata.name',
          'metadata.title',
          'metadata.namespace',
          'spec.type',
          'spec.lifecycle',
          'relations',
        ],
      },
      { token },
    );
    const docPromises = entities.items
      .filter(it => it.metadata?.annotations?.['backstage.io/techdocs-ref'])
      .map((entity: Entity) =>
        limit(async (): Promise<TechDocsDocument[]> => {
          const entityInfo = DefaultTechDocsCollator.handleEntityInfoCasing(
            this.legacyPathCasing ?? false,
            {
              kind: entity.kind,
              namespace: entity.metadata.namespace || 'default',
              name: entity.metadata.name,
            },
          );

          try {
            const searchIndexResponse = await fetch(
              DefaultTechDocsCollator.constructDocsIndexUrl(
                techDocsBaseUrl,
                entityInfo,
              ),
              {
                headers: {
                  Authorization: `Bearer ${token}`,
                },
              },
            );
            const searchIndex = await searchIndexResponse.json();

            return searchIndex.docs.map((doc: MkSearchIndexDoc) => ({
              title: unescape(doc.title),
              text: unescape(doc.text || ''),
              location: this.applyArgsToFormat(
                locationTemplate || '/docs/:namespace/:kind/:name/:path',
                {
                  ...entityInfo,
                  path: doc.location,
                },
              ),
              path: doc.location,
              ...entityInfo,
              entityTitle: entity.metadata.title,
              componentType: entity.spec?.type?.toString() || 'other',
              lifecycle: (entity.spec?.lifecycle as string) || '',
              owner:
                entity.relations?.find(r => r.type === RELATION_OWNED_BY)
                  ?.target?.name || '',
              authorization: {
                resourceRef: stringifyEntityRef(entity),
              },
            }));
          } catch (e) {
            logger.debug(
              `Failed to retrieve tech docs search index for entity ${entityInfo.namespace}/${entityInfo.kind}/${entityInfo.name}`,
              e,
            );
            return [];
          }
        }),
      );
    return (await Promise.all(docPromises)).flat();
  }

  protected applyArgsToFormat(
    format: string,
    args: Record<string, string>,
  ): string {
    let formatted = format;
    for (const [key, value] of Object.entries(args)) {
      formatted = formatted.replace(`:${key}`, value);
    }
    return formatted;
  }

  private static constructDocsIndexUrl(
    techDocsBaseUrl: string,
    entityInfo: { kind: string; namespace: string; name: string },
  ) {
    return `${techDocsBaseUrl}/static/docs/${entityInfo.namespace}/${entityInfo.kind}/${entityInfo.name}/search/search_index.json`;
  }

  private static handleEntityInfoCasing(
    legacyPaths: boolean,
    entityInfo: EntityInfo,
  ): EntityInfo {
    return legacyPaths
      ? entityInfo
      : Object.entries(entityInfo).reduce((acc, [key, value]) => {
          return { ...acc, [key]: value.toLocaleLowerCase('en-US') };
        }, {} as EntityInfo);
  }
}
