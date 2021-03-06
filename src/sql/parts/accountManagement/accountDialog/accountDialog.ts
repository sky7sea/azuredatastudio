/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./media/accountDialog';
import 'vs/css!sql/parts/accountManagement/common/media/accountActions';
import * as DOM from 'vs/base/browser/dom';
import { SplitView } from 'sql/base/browser/ui/splitview/splitview';
import { List } from 'vs/base/browser/ui/list/listWidget';
import { IListService, ListService } from 'vs/platform/list/browser/listService';
import { IPartService } from 'vs/workbench/services/part/common/partService';
import { Event, Emitter } from 'vs/base/common/event';
import { localize } from 'vs/nls';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { attachListStyler } from 'vs/platform/theme/common/styler';
import { ActionRunner } from 'vs/base/common/actions';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import * as TelemetryKeys from 'sql/common/telemetryKeys';

import * as sqlops from 'sqlops';
import { Button } from 'sql/base/browser/ui/button/button';
import { Modal } from 'sql/base/browser/ui/modal/modal';
import { attachModalDialogStyler, attachButtonStyler } from 'sql/common/theme/styler';
import { AccountViewModel } from 'sql/parts/accountManagement/accountDialog/accountViewModel';
import { AddAccountAction } from 'sql/parts/accountManagement/common/accountActions';
import { AccountListRenderer, AccountListDelegate } from 'sql/parts/accountManagement/common/accountListRenderer';
import { AccountProviderAddedEventParams, UpdateAccountListEventParams } from 'sql/services/accountManagement/eventTypes';
import { FixedListView } from 'sql/platform/views/fixedListView';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IClipboardService } from 'sql/platform/clipboard/common/clipboardService';

export interface IProviderViewUiComponent {
	view: FixedListView<sqlops.Account>;
	addAccountAction: AddAccountAction;
}

export class AccountDialog extends Modal {
	public static ACCOUNTLIST_HEIGHT = 77;

	public viewModel: AccountViewModel;

	// MEMBER VARIABLES ////////////////////////////////////////////////////
	private _providerViews: { [providerId: string]: IProviderViewUiComponent } = {};

	private _closeButton: Button;
	private _addAccountButton: Button;
	private _delegate: AccountListDelegate;
	private _accountRenderer: AccountListRenderer;
	private _actionRunner: ActionRunner;
	private _splitView: SplitView;
	private _container: HTMLElement;
	private _splitViewContainer: HTMLElement;
	private _noaccountViewContainer: HTMLElement;

	// EVENTING ////////////////////////////////////////////////////////////
	private _onAddAccountErrorEmitter: Emitter<string>;
	public get onAddAccountErrorEvent(): Event<string> { return this._onAddAccountErrorEmitter.event; }

	private _onCloseEmitter: Emitter<void>;
	public get onCloseEvent(): Event<void> { return this._onCloseEmitter.event; }

	constructor(
		@IPartService partService: IPartService,
		@IThemeService themeService: IThemeService,
		@IListService private _listService: IListService,
		@IInstantiationService private _instantiationService: IInstantiationService,
		@IContextMenuService private _contextMenuService: IContextMenuService,
		@IKeybindingService private _keybindingService: IKeybindingService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IClipboardService clipboardService: IClipboardService
	) {
		super(
			localize('linkedAccounts', 'Linked accounts'),
			TelemetryKeys.Accounts,
			partService,
			telemetryService,
			clipboardService,
			themeService,
			contextKeyService,
			{ hasSpinner: true }
		);
		let self = this;

		this._delegate = new AccountListDelegate(AccountDialog.ACCOUNTLIST_HEIGHT);
		this._accountRenderer = this._instantiationService.createInstance(AccountListRenderer);
		this._actionRunner = new ActionRunner();

		// Setup the event emitters
		this._onAddAccountErrorEmitter = new Emitter<string>();
		this._onCloseEmitter = new Emitter<void>();

		// Create the view model and wire up the events
		this.viewModel = this._instantiationService.createInstance(AccountViewModel);
		this.viewModel.addProviderEvent(arg => { self.addProvider(arg); });
		this.viewModel.removeProviderEvent(arg => { self.removeProvider(arg); });
		this.viewModel.updateAccountListEvent(arg => { self.updateProviderAccounts(arg); });

		// Load the initial contents of the view model
		this.viewModel.initialize()
			.then(addedProviders => {
				for (let addedProvider of addedProviders) {
					self.addProvider(addedProvider);
				}
			});
	}

	// MODAL OVERRIDE METHODS //////////////////////////////////////////////
	protected layout(height?: number): void {
		// Ignore height as it's a subcomponent being laid out
		this._splitView.layout(DOM.getContentHeight(this._container));
	}

	public render() {
		let self = this;

		super.render();
		attachModalDialogStyler(this, this._themeService);
		this._closeButton = this.addFooterButton(localize('accountDialog.close', 'Close'), () => this.close());
		this.registerListeners();
	}

	protected renderBody(container: HTMLElement) {
		this._container = container;
		this._splitViewContainer = DOM.$('div.account-view');
		DOM.append(container, this._splitViewContainer);
		this._splitView = new SplitView(this._splitViewContainer);

		this._noaccountViewContainer = DOM.$('div.no-account-view');
		let noAccountTitle = DOM.append(this._noaccountViewContainer, DOM.$('.no-account-view-label'));
		let noAccountLabel = localize('accountDialog.noAccountLabel', 'There is no linked account. Please add an account.');
		noAccountTitle.innerText = noAccountLabel;

		// Show the add account button for the first provider
		// Todo: If we have more than 1 provider, need to show all add account buttons for all providers
		let buttonSection = DOM.append(this._noaccountViewContainer, DOM.$('div.button-section'));
		this._addAccountButton = new Button(buttonSection);
		this._addAccountButton.label = localize('accountDialog.addConnection', 'Add an account');
		this._register(this._addAccountButton.onDidClick(() => {
			(<IProviderViewUiComponent>Object.values(this._providerViews)[0]).addAccountAction.run();
		}));

		DOM.append(container, this._noaccountViewContainer);
	}

	private registerListeners(): void {
		// Theme styler
		this._register(attachButtonStyler(this._closeButton, this._themeService));
		this._register(attachButtonStyler(this._addAccountButton, this._themeService));
	}

	/* Overwrite escape key behavior */
	protected onClose() {
		this.close();
	}

	/* Overwrite enter key behavior */
	protected onAccept() {
		this.close();
	}

	public close() {
		this._onCloseEmitter.fire();
		this.hide();
	}

	public open() {
		this.show();
		if (!this.isEmptyLinkedAccount()) {
			this.showSplitView();
		} else {
			this.showNoAccountContainer();
		}

	}

	private showNoAccountContainer() {
		this._splitViewContainer.hidden = true;
		this._noaccountViewContainer.hidden = false;
		this._addAccountButton.focus();
	}

	private showSplitView() {
		this._splitViewContainer.hidden = false;
		this._noaccountViewContainer.hidden = true;
		let views = this._splitView.getViews();
		if (views && views.length > 0) {
			let firstView = views[0];
			if (firstView instanceof FixedListView) {
				firstView.list.setSelection([0]);
				firstView.list.domFocus();
			}
		}
	}

	private isEmptyLinkedAccount(): boolean {
		for (var providerId in this._providerViews) {
			var listView = this._providerViews[providerId].view;
			if (listView && listView.list.length > 0) {
				return false;
			}
		}
		return true;
	}

	public dispose(): void {
		super.dispose();
		for (let key in this._providerViews) {
			if (this._providerViews[key].addAccountAction) {
				this._providerViews[key].addAccountAction.dispose();
			}
			if (this._providerViews[key].view) {
				this._providerViews[key].view.dispose();
			}
			delete this._providerViews[key];
		}
	}

	// PRIVATE HELPERS /////////////////////////////////////////////////////
	private addProvider(newProvider: AccountProviderAddedEventParams) {
		let self = this;

		// Skip adding the provider if it already exists
		if (this._providerViews[newProvider.addedProvider.id]) {
			return;
		}

		// Account provider doesn't exist, so add it
		// Create a scoped add account action
		let addAccountAction = this._instantiationService.createInstance(
			AddAccountAction,
			newProvider.addedProvider.id
		);
		addAccountAction.addAccountCompleteEvent(() => { self.hideSpinner(); });
		addAccountAction.addAccountErrorEvent(msg => { self._onAddAccountErrorEmitter.fire(msg); });
		addAccountAction.addAccountStartEvent(() => { self.showSpinner(); });

		// Create a fixed list view for the account provider
		let providerViewContainer = DOM.$('.provider-view');
		let accountList = new List<sqlops.Account>(providerViewContainer, this._delegate, [this._accountRenderer]);
		let providerView = new FixedListView<sqlops.Account>(
			undefined,
			false,
			newProvider.addedProvider.displayName,
			accountList,
			providerViewContainer,
			22,
			[addAccountAction],
			this._actionRunner,
			this._contextMenuService,
			this._keybindingService,
			this._themeService
		);

		// Append the list view to the split view
		this._splitView.addView(providerView);
		this._register(attachListStyler(accountList, this._themeService));

		let listService = <ListService>this._listService;
		this._register(listService.register(accountList));
		this._splitView.layout(DOM.getContentHeight(this._container));

		// Set the initial items of the list
		providerView.updateList(newProvider.initialAccounts);

		if (newProvider.initialAccounts.length > 0 && this._splitViewContainer.hidden) {
			this.showSplitView();
		}

		this.layout();

		// Store the view for the provider and action
		this._providerViews[newProvider.addedProvider.id] = { view: providerView, addAccountAction: addAccountAction };
	}

	private removeProvider(removedProvider: sqlops.AccountProviderMetadata) {
		// Skip removing the provider if it doesn't exist
		let providerView = this._providerViews[removedProvider.id];
		if (!providerView || !providerView.view) {
			return;
		}

		// Remove the list view from the split view
		this._splitView.removeView(providerView.view);
		this._splitView.layout(DOM.getContentHeight(this._container));

		// Remove the list view from our internal map
		delete this._providerViews[removedProvider.id];
		this.layout();
	}

	private updateProviderAccounts(args: UpdateAccountListEventParams) {
		let providerMapping = this._providerViews[args.providerId];
		if (!providerMapping || !providerMapping.view) {
			return;
		}
		providerMapping.view.updateList(args.accountList);

		if (args.accountList.length > 0 && this._splitViewContainer.hidden) {
			this.showSplitView();
		}

		if (this.isEmptyLinkedAccount() && this._noaccountViewContainer.hidden) {
			this.showNoAccountContainer();
		}

		this.layout();
	}
}
