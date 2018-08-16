import { module, IComponentController, IScope, IPromise, IQService } from 'angular';
import {
  isString,
  isFinite,
  isNil,
  get,
  has,
  isEmpty,
  map,
  uniq,
  difference,
  cloneDeep,
} from 'lodash';
import autoBindMethods from 'class-autobind-decorator';

import {
  AccountService, AppListExtractor, CloudProviderRegistry, IAccountDetails,
  IPipeline, IServerGroup, NameUtils, ProviderSelectionService,
  Registry, ServerGroupCommandBuilderService,
} from '@spinnaker/core';

import { CanarySettings } from 'kayenta/canary.settings';
import {
  getCanaryConfigById,
  listKayentaAccounts,
} from 'kayenta/service/canaryConfig.service';
import { ICanaryConfig, ICanaryConfigSummary, IKayentaAccount, KayentaAccountType } from 'kayenta/domain/index';
import { CANARY_SCORES_CONFIG_COMPONENT } from 'kayenta/components/canaryScores.component';
import { KayentaStageTransformer, KAYENTA_STAGE_TRANSFORMER } from './kayentaStage.transformer';
import { KAYENTA_STAGE_EXECUTION_DETAILS_CONTROLLER } from './kayentaStageExecutionDetails.controller';
import { KAYENTA_STAGE_CONFIG_SECTION } from './kayentaStageConfigSection.component';
import { KAYENTA_ANALYSIS_TYPE_COMPONENT } from './analysisType.component';
import {IModalService} from 'angular-ui-bootstrap';

interface IKayentaStage {
  canaryConfig: IKayentaStageCanaryConfig;
  analysisType: KayentaAnalysisType;
  deployments: IKayentaStageDeployments;
}

interface IKayentaStageCanaryConfig {
  beginCanaryAnalysisAfterMins?: string;
  canaryAnalysisIntervalMins: string;
  canaryConfigId: string;
  scopes: IKayentaStageCanaryConfigScope[];
  combinedCanaryResultStrategy: string;
  lifetimeHours?: string;
  lifetimeDuration?: string;
  lookbackMins?: string;
  metricsAccountName: string;
  scoreThresholds: {
    pass: string;
    marginal: string;
  };
  storageAccountName: string;
}

interface IKayentaStageCanaryConfigScope {
  scopeName: string;
  controlScope?: string;
  controlLocation?: string;
  experimentScope?: string;
  experimentLocation?: string;
  startTimeIso?: string;
  endTimeIso?: string;
  step?: number;
  extendedScopeParams: {[key: string]: string};
}

interface IKayentaStageDeployments {
  baseline: {
    cloudProvider: string;
    application: string;
    account: string;
    cluster: string;
  };
  clusterPairs: Array<{ control: any, experiment: any }>;
  delayBeforeCleanup: number;
}

interface IKayentaStageLifetime {
  hours?: number;
  minutes?: number;
}

export enum KayentaAnalysisType {
  RealTimeAutomatic = 'realTimeAutomatic',
  RealTime = 'realTime',
  Retrospective = 'retrospective',
}

@autoBindMethods
class CanaryStage implements IComponentController {
  public state = {
    useLookback: false,
    backingDataLoading: false,
    detailsLoading: false,
    lifetimeHoursUpdatedToDuration: false,
    lifetime: { hours: '', minutes: '' },
  };
  public canaryConfigSummaries: ICanaryConfigSummary[] = [];
  public selectedCanaryConfigDetails: ICanaryConfig;
  public scopeNames: string[] = [];
  public kayentaAccounts = new Map<KayentaAccountType, IKayentaAccount[]>();
  public metricStore: string;
  public providers: string[];
  public accounts: IAccountDetails[];
  public clusterList: string[];

  constructor(private $uibModal: IModalService, private serverGroupCommandBuilder: ServerGroupCommandBuilderService, private $q: IQService, private $scope: IScope, public stage: IKayentaStage, private serverGroupTransformer: any, private providerSelectionService: ProviderSelectionService) {
    'ngInject';
    this.initialize();
  }

  public onUseLookbackChange(): void {
    if (!this.state.useLookback) {
      delete this.stage.canaryConfig.lookbackMins;
    }
  }

  public onCanaryConfigSelect(): void {
    this.loadCanaryConfigDetails().then(() => this.overrideScoreThresholds());
  }

  public isExpression(val: number | string): boolean {
    return isString(val) && val.includes('${');
  }

  public handleScoreThresholdChange(scoreThresholds: { successfulScore: string, unhealthyScore: string }): void {
    // Called from a React component.
    this.$scope.$applyAsync(() => {
      this.stage.canaryConfig.scoreThresholds.pass = scoreThresholds.successfulScore;
      this.stage.canaryConfig.scoreThresholds.marginal = scoreThresholds.unhealthyScore;
    });
  }

  public handleAnalysisTypeChange(type: KayentaAnalysisType): void {
    this.stage.analysisType = type;

    switch (this.stage.analysisType) {
      case KayentaAnalysisType.RealTime:
        delete this.stage.canaryConfig.scopes[0].startTimeIso;
        delete this.stage.canaryConfig.scopes[0].endTimeIso;
        delete this.stage.deployments;
        break;
      case KayentaAnalysisType.RealTimeAutomatic:
        delete this.stage.canaryConfig.scopes[0].startTimeIso;
        delete this.stage.canaryConfig.scopes[0].endTimeIso;
        break;
      case KayentaAnalysisType.Retrospective:
        delete this.stage.canaryConfig.beginCanaryAnalysisAfterMins;
        delete this.stage.canaryConfig.lifetimeDuration;
        delete this.stage.deployments;
        break;
    }
    this.$scope.$applyAsync();
  }

  private initialize(): void {
    this.stage.canaryConfig = this.stage.canaryConfig || {} as IKayentaStageCanaryConfig;
    this.stage.canaryConfig.storageAccountName =
      this.stage.canaryConfig.storageAccountName || CanarySettings.storageAccountName;
    this.stage.canaryConfig.metricsAccountName =
      this.stage.canaryConfig.metricsAccountName || CanarySettings.metricsAccountName;
    this.stage.canaryConfig.combinedCanaryResultStrategy =
      this.stage.canaryConfig.combinedCanaryResultStrategy || 'LOWEST';
    this.stage.analysisType =
      this.stage.analysisType || KayentaAnalysisType.RealTime;

    this.updateLifetimeFromHoursToDuration();
    const stageLifetime = this.getLifetimeFromStageLifetimeDuration();
    if (!isNil(stageLifetime.hours)) {
      this.state.lifetime.hours = String(stageLifetime.hours);
    }
    if (!isNil(stageLifetime.minutes)) {
      this.state.lifetime.minutes = String(stageLifetime.minutes);
    }

    if (this.stage.canaryConfig.lookbackMins) {
      this.state.useLookback = true;
    }

    if (!this.stage.canaryConfig.scopes || !this.stage.canaryConfig.scopes.length) {
      this.stage.canaryConfig.scopes =
        [{ scopeName: 'default' } as IKayentaStageCanaryConfigScope];
    }

    this.loadBackingData().then(() => {
      this.setClusterList() ;
    });
  }

  private loadCanaryConfigDetails(): IPromise<void> {
    if (!this.stage.canaryConfig.canaryConfigId) {
      return this.$q.resolve(null);
    }

    this.state.detailsLoading = true;
    return this.$q.resolve(getCanaryConfigById(this.stage.canaryConfig.canaryConfigId).then(configDetails => {
      this.state.detailsLoading = false;
      this.selectedCanaryConfigDetails = configDetails;
      this.populateScopeNameChoices(configDetails);
      this.metricStore = get(configDetails, 'metrics[0].query.type');
    }).catch(() => {
      this.state.detailsLoading = false;
    }));
  }

  // Should only be called when selecting a canary config.
  // Expected stage behavior:
  // On stage load, use the stage's score thresholds rather than the canary config's
  // thresholds.
  // When selecting a canary config, set the stage's thresholds equal
  // to the canary config's thresholds unless they are undefined.
  // In that case, fall back on the stage's thresholds.
  private overrideScoreThresholds(): void {
    if (!this.selectedCanaryConfigDetails) {
      return;
    }

    if (!this.stage.canaryConfig.scoreThresholds) {
      this.stage.canaryConfig.scoreThresholds = { marginal: null, pass: null };
    }

    this.stage.canaryConfig.scoreThresholds.marginal = get(
      this.selectedCanaryConfigDetails, 'classifier.scoreThresholds.marginal',
      this.stage.canaryConfig.scoreThresholds.marginal || ''
    ).toString();
    this.stage.canaryConfig.scoreThresholds.pass = get(
      this.selectedCanaryConfigDetails, 'classifier.scoreThresholds.pass',
      this.stage.canaryConfig.scoreThresholds.pass || ''
    ).toString();
  }

  private populateScopeNameChoices(configDetails: ICanaryConfig): void {
    const scopeNames = uniq(map(configDetails.metrics, metric => metric.scopeName || 'default'));
    this.scopeNames = !isEmpty(scopeNames) ? scopeNames : ['default'];

    if (!isEmpty(this.stage.canaryConfig.scopes) && !scopeNames.includes(this.stage.canaryConfig.scopes[0].scopeName)) {
      delete this.stage.canaryConfig.scopes[0].scopeName;
    } else if (isEmpty(this.stage.canaryConfig.scopes)) {
      this.stage.canaryConfig.scopes = [{ scopeName: scopeNames[0] }] as IKayentaStageCanaryConfigScope[];
    }
  }

  private loadBackingData(): IPromise<void> {
    this.state.backingDataLoading = true;
    return this.$q.all([
      this.$scope.application.ready().then(() => {
        this.setCanaryConfigSummaries(this.$scope.application.getDataSource('canaryConfigs').data);
        this.deleteCanaryConfigIdIfMissing();
        this.loadCanaryConfigDetails();
      }),
      listKayentaAccounts().then(this.setKayentaAccounts).then(this.deleteConfigAccountsIfMissing),
      this.loadProviders(),
      this.loadAccounts(),
    ]).then(() => { this.state.backingDataLoading = false })
      .catch(() => { this.state.backingDataLoading = false });
  }

  private setKayentaAccounts(accounts: IKayentaAccount[]): void {
    accounts.forEach(account => {
      account.supportedTypes.forEach(type => {
        if (this.kayentaAccounts.has(type)) {
          this.kayentaAccounts.set(type, this.kayentaAccounts.get(type).concat([account]));
        } else {
          this.kayentaAccounts.set(type, [account]);
        }
      });
    });
  }

  private deleteConfigAccountsIfMissing(): void {
    if ((this.kayentaAccounts.get(KayentaAccountType.ObjectStore) || [])
          .every(account => account.name !== this.stage.canaryConfig.storageAccountName)) {
      delete this.stage.canaryConfig.storageAccountName;
    }
    if ((this.kayentaAccounts.get(KayentaAccountType.MetricsStore) || [])
          .every(account => account.name !== this.stage.canaryConfig.metricsAccountName)) {
      delete this.stage.canaryConfig.metricsAccountName;
    }
  }

  private setCanaryConfigSummaries(summaries: ICanaryConfigSummary[]): void {
    this.canaryConfigSummaries = summaries;
  }

  private deleteCanaryConfigIdIfMissing(): void {
    if (this.canaryConfigSummaries.every(s => s.id !== this.stage.canaryConfig.canaryConfigId)) {
      delete this.stage.canaryConfig.canaryConfigId;
    }
  }

  public populateScopeWithExpressions(): void {
    this.stage.canaryConfig.scopes[0].controlScope =
      '${ #stage(\'Clone Server Group\')[\'context\'][\'source\'][\'serverGroupName\'] }';
    this.stage.canaryConfig.scopes[0].controlLocation =
      '${ deployedServerGroups[0].region }';
    this.stage.canaryConfig.scopes[0].experimentScope =
      '${ deployedServerGroups[0].serverGroup }';
    this.stage.canaryConfig.scopes[0].experimentLocation =
      '${ deployedServerGroups[0].region }';
  }

  public onLifetimeChange(): void {
    const { hours, minutes } = this.getStateLifetime();
    this.stage.canaryConfig.lifetimeDuration = `PT${hours}H${minutes}M`;
  }

  private updateLifetimeFromHoursToDuration(): void {
    if (has(this.stage, ['canaryConfig', 'lifetimeHours'])) {
      const hours = parseInt(this.stage.canaryConfig.lifetimeHours, 10);
      if (isFinite(hours)) {
        const fractional =
          parseFloat(this.stage.canaryConfig.lifetimeHours) - hours;
        const minutes = Math.floor(fractional * 60);
        this.stage.canaryConfig.lifetimeDuration = `PT${hours}H`;
        if (isFinite(minutes)) {
          this.stage.canaryConfig.lifetimeDuration += `${minutes}M`;
        }
        this.state.lifetimeHoursUpdatedToDuration = true;
      }
      delete this.stage.canaryConfig.lifetimeHours;
    }
  }

  private getStateLifetime(): IKayentaStageLifetime {
    let hours = parseInt(this.state.lifetime.hours, 10);
    let minutes = parseInt(this.state.lifetime.minutes, 10);
    if (!isFinite(hours) || hours < 0) {
      hours = 0;
    }
    if (!isFinite(minutes) || minutes < 0) {
      minutes = 0;
    }
    return { hours, minutes };
  }

  private getLifetimeFromStageLifetimeDuration(): IKayentaStageLifetime {
    const duration = get(this.stage, ['canaryConfig', 'lifetimeDuration']);
    if (!isString(duration)) {
      return {};
    }
    const lifetimeComponents = duration.match(/PT(\d+)H(?:(\d+)M)?/i);
    if (lifetimeComponents == null) {
      return {};
    }
    const hours = parseInt(lifetimeComponents[1], 10);
    if (!isFinite(hours) || hours < 0) {
      return {};
    }
    let minutes = parseInt(lifetimeComponents[2], 10);
    if (!isFinite(minutes) || minutes < 0) {
      minutes = 0;
    }
    return { hours, minutes };
  }

  public isLifetimeRequired(): boolean {
    const lifetime = this.getStateLifetime();
    return lifetime.hours === 0 && lifetime.minutes === 0;
  }

  public getLifetimeClassnames(): string {
    if (this.state.lifetimeHoursUpdatedToDuration) {
      return 'alert alert-warning';
    }
    return '';
  }

  private loadProviders(): void {
    AccountService.listProviders(this.$scope.application).then(providers => {
      this.providers = providers.filter(p => ['aws', 'gce'].includes(p));
    });
  }

  private loadAccounts(): void {
    // TODO(dpeach): not just gce!
    AccountService.listAccounts('gce')
      .then(accounts => (this.accounts = accounts));
  }

  private setClusterList(): void {
    this.clusterList = AppListExtractor.getClusters([this.$scope.application], sg =>
      this.stage.deployments.baseline.account
        ? sg.account === this.stage.deployments.baseline.account
        : true
    );
  }

  public getRegion(serverGroup: any): string {
    if (serverGroup.region) {
      return serverGroup.region;
    }
    const availabilityZones = serverGroup.availabilityZones;

    return availabilityZones
      ? Object.keys(availabilityZones).length
        ? Object.keys(availabilityZones)[0]
        : 'n/a'
      : 'n/a';
  };

  public getServerGroupName(serverGroup: any): string {
    return NameUtils.getClusterName(
      serverGroup.application,
      serverGroup.stack,
      serverGroup.freeFormDetails);
  }

  public addPair() {
    this.stage.deployments.clusterPairs = this.stage.deployments.clusterPairs || [];
    this.providerSelectionService.selectProvider(this.$scope.application, 'serverGroup').then((selectedProvider) => {
      const config = CloudProviderRegistry.getValue(selectedProvider, 'serverGroup');

      const handleResult = (command) => {
        const control = this.serverGroupTransformer.convertServerGroupCommandToDeployConfiguration(command),
          experiment = cloneDeep(control);
        this.cleanupServerGroupCommand(control, 'control');
        this.cleanupServerGroupCommand(experiment, 'experiment');
        this.stage.deployments.clusterPairs.push({ control, experiment });
      };

      const title = 'Add Cluster Pair';
      const application = this.$scope.application;

      this.serverGroupCommandBuilder.buildNewServerGroupCommandForPipeline(selectedProvider, null, null).then((command) => {
        command.viewState.disableStrategySelection = true;
        command.viewState.hideClusterNamePreview = true;
        command.viewState.readOnlyFields = { credentials: true, region: true, subnet: true, useSourceCapacity: true };
        delete command.strategy;
        command.viewState.overrides = {
          capacity: {
            min: 1,
            max: 1,
            desired: 1,
          },
          useSourceCapacity: false,
        };
        command.viewState.disableNoTemplateSelection = true;
        command.viewState.customTemplateMessage =
          'Select a template to configure the canary and baseline ' +
          'cluster pair. If you want to configure the server groups differently, you can do so by clicking ' +
          '"Edit" after adding the pair.';

        if (config.CloneServerGroupModal) {
          // react
          config.CloneServerGroupModal.show({ title, application, command });
        } else {
          // angular
          this.$uibModal
            .open({
              templateUrl: config.cloneServerGroupTemplateUrl,
              controller: `${config.cloneServerGroupController} as ctrl`,
              size: 'lg',
              resolve: {
                title: () => title,
                application: () => application,
                serverGroupCommand: () => command,
              },
            })
            .result.then(handleResult)
            .catch(() => {});
        }
      });
    });
  }
  public editServerGroup(serverGroup: any, index: number, type: string) {
    serverGroup.provider = serverGroup.cloudProvider || serverGroup.provider;
    const config = CloudProviderRegistry.getValue(serverGroup.provider, 'serverGroup');
    this.$uibModal
      .open({
        templateUrl: config.cloneServerGroupTemplateUrl,
        controller: `${config.cloneServerGroupController} as ctrl`,
        size: 'lg',
        resolve: {
          title: () => 'Configure ' + type + ' Cluster',
          application: () => {
            return this.$scope.application;
          },
          serverGroupCommand: () => {
            return this.serverGroupCommandBuilder
              .buildServerGroupCommandFromPipeline(this.$scope.application, serverGroup, null, null)
              .then((command: any) => {
                command.viewState.disableStrategySelection = true;
                command.viewState.hideClusterNamePreview = true;
                command.viewState.readOnlyFields = { credentials: true, region: true, subnet: true, useSourceCapacity: true };
                delete command.strategy;
                return command;
              });
          },
        },
      })
      .result.then((command: any) => {
        const serverGroup = this.serverGroupTransformer.convertServerGroupCommandToDeployConfiguration(command);
        const pair = this.stage.deployments.clusterPairs[index];
        if (type === 'Control') {
          pair.control = serverGroup;
        } else {
          pair.experiment = serverGroup;
        }
      })
      .catch(() => {});
  };

  public deletePair(index: number): void {
    (this.stage.deployments.clusterPairs || []).splice(index, 1);
  }

  private cleanupServerGroupCommand(serverGroup: any, type: string) {
    delete serverGroup.credentials;
    if (serverGroup.freeFormDetails && serverGroup.freeFormDetails.split('-').pop() === type.toLowerCase()) {
      return;
    }
    if (serverGroup.freeFormDetails) {
      serverGroup.freeFormDetails += '-';
    }
    serverGroup.freeFormDetails += type.toLowerCase();
    serverGroup.moniker = NameUtils.getMoniker(serverGroup.application, serverGroup.stack, serverGroup.freeFormDetails);
  }
}

const requiredForAnalysisType = (analysisType: KayentaAnalysisType, fieldName: string, fieldLabel?: string): (p: IPipeline, s: IKayentaStage) => string => {
  return (_pipeline: IPipeline, stage: IKayentaStage): string => {
    if (stage.analysisType === analysisType) {
      if (!has(stage, fieldName) || get(stage, fieldName) === '') {
        return `<strong>${fieldLabel || fieldName}</strong> is a required field for Kayenta Canary stages.`;
      }
    }
    return null;
  }
};

const allScopesMustBeConfigured = (_pipeline: IPipeline, stage: IKayentaStage): Promise<string> => {
  return getCanaryConfigById(get(stage, 'canaryConfig.canaryConfigId')).then(configDetails => {
    let definedScopeNames = uniq(map(configDetails.metrics, metric => metric.scopeName || 'default'));
    definedScopeNames = !isEmpty(definedScopeNames) ? definedScopeNames : ['default'];

    const configureScopedNames: string[] = map(get(stage, 'canaryConfig.scopes'), 'scopeName');
    const missingScopeNames = difference(definedScopeNames, configureScopedNames);

    if (missingScopeNames.length > 1) {
      return `Scopes <strong>${missingScopeNames.join()}</strong> are defined but not configured.`;
    } else if (missingScopeNames.length === 1) {
      return `Scope <strong>${missingScopeNames[0]}</strong> is defined but not configured.`;
    } else {
      return null;
    }
  });
};

const allConfiguredScopesMustBeDefined = (_pipeline: IPipeline, stage: IKayentaStage): Promise<string> => {
  return getCanaryConfigById(get(stage, 'canaryConfig.canaryConfigId')).then(configDetails => {
    let definedScopeNames = uniq(map(configDetails.metrics, metric => metric.scopeName || 'default'));
    definedScopeNames = !isEmpty(definedScopeNames) ? definedScopeNames : ['default'];

    const configureScopedNames: string[] = map(get(stage, 'canaryConfig.scopes'), 'scopeName');
    const missingScopeNames = difference(configureScopedNames, definedScopeNames);

    if (missingScopeNames.length > 1) {
      return `Scopes <strong>${missingScopeNames.join()}</strong> are configured but are not defined in the canary configuration.`;
    } else if (missingScopeNames.length === 1) {
      return `Scope <strong>${missingScopeNames[0]}</strong> is configured but is not defined in the canary configuration.`;
    } else {
      return null;
    }
  });
};

export const KAYENTA_CANARY_STAGE = 'spinnaker.kayenta.canaryStage';
module(KAYENTA_CANARY_STAGE, [
    CANARY_SCORES_CONFIG_COMPONENT,
    KAYENTA_ANALYSIS_TYPE_COMPONENT,
    KAYENTA_STAGE_CONFIG_SECTION,
    KAYENTA_STAGE_TRANSFORMER,
    KAYENTA_STAGE_EXECUTION_DETAILS_CONTROLLER,
  ])
  .config(() => {
    'ngInject';
    Registry.pipeline.registerStage({
      label: 'Canary Analysis',
      description: 'Runs a canary task',
      key: 'kayentaCanary',
      templateUrl: require('./kayentaStage.html'),
      controller: 'KayentaCanaryStageCtrl',
      controllerAs: 'kayentaCanaryStageCtrl',
      executionDetailsUrl: require('./kayentaStageExecutionDetails.html'),
      validators: [
        { type: 'requiredField', fieldName: 'canaryConfig.canaryConfigId', fieldLabel: 'Config Name' },
        { type: 'requiredField', fieldName: 'canaryConfig.scopes[0].controlScope', fieldLabel: 'Baseline Scope' },
        { type: 'requiredField', fieldName: 'canaryConfig.scopes[0].experimentScope', fieldLabel: 'Canary Scope' },
        { type: 'requiredField', fieldName: 'canaryConfig.metricsAccountName', fieldLabel: 'Metrics Account' },
        { type: 'requiredField', fieldName: 'canaryConfig.storageAccountName', fieldLabel: 'Storage Account' },
        { type: 'custom', validate: requiredForAnalysisType(KayentaAnalysisType.RealTime, 'canaryConfig.lifetimeDuration', 'Lifetime') },
        { type: 'custom', validate: requiredForAnalysisType(KayentaAnalysisType.Retrospective, 'canaryConfig.scopes[0].startTimeIso', 'Start Time') },
        { type: 'custom', validate: requiredForAnalysisType(KayentaAnalysisType.Retrospective, 'canaryConfig.scopes[0].endTimeIso', 'End Time') },
        { type: 'custom', validate: allScopesMustBeConfigured },
        { type: 'custom', validate: allConfiguredScopesMustBeDefined },
      ]
    });
  })
  .controller('KayentaCanaryStageCtrl', CanaryStage)
  .run((kayentaStageTransformer: KayentaStageTransformer) => {
    'ngInject';
    Registry.pipeline.registerTransformer(kayentaStageTransformer);
  });
