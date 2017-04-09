import {TiledFeatureComponent, TiledMapFeatureData} from '../map-feature.component';
import {TileObject} from '../../../../../game/pow2/tile/tileObject';
import {
  Component,
  Input,
  ViewEncapsulation,
  ChangeDetectionStrategy,
  EventEmitter,
  Output,
  OnDestroy
} from '@angular/core';
import {Observable, BehaviorSubject, Subject} from 'rxjs';
import {IScene} from '../../../../../game/pow2/interfaces/IScene';
import {ITemplateItem, ITemplateWeapon} from '../../../../models/game-data/game-data.model';
import {
  GameStateAddInventoryAction,
  GameStateAddGoldAction,
  GameStateRemoveInventoryAction
} from '../../../../models/game-state/game-state.actions';
import {EntityAddItemAction, EntityRemoveItemAction} from '../../../../models/entity/entity.actions';
import {newGuid} from '../../../../models/base-entity';
import {GameState} from '../../../../models/game-state/game-state.model';
import {
  sliceGameState,
  getGameInventory,
  getGamePartyGold,
  getGameDataItems,
  getGameDataArmors,
  getGameDataWeapons
} from '../../../../models/selectors';
import {Item} from '../../../../models/item';
import {AppState} from '../../../../app.model';
import {RPGGame} from '../../../../services/rpgGame';
import {NotificationService} from '../../../../components/notification/notification.service';
import {Store} from '@ngrx/store';
import Immutable from 'immutable';

/**
 * Given a list of potential items, filter it to only ones that can be bartered in this store.
 * @param items The list of items to filter
 * @param groups The item groups that are supported by this store
 * @param level The level of items that are sold in this store
 * @returns {ITemplateItem[]} The filtered item list
 */
export function storeItemsFilter(items: ITemplateItem[], groups: string[], level: number): ITemplateItem[] {
  return items.filter((i: ITemplateItem) => {
    const levelMatch: boolean = (typeof i.level === 'undefined' || i.level === level);
    return levelMatch && itemInGroups(i, groups);
  });
}

/**
 * Given a list of potential items to sell, filter to only ones that can be bartered in this store.
 * @param items The list of items to filter
 * @param groups The item groups that are supported by this store
 * @returns {ITemplateItem[]} The filtered item list
 */
export function sellItemsFilter(items: ITemplateItem[], groups: string[]): ITemplateItem[] {
  return (items || []).filter((i: ITemplateItem) => {
    return itemInGroups(i, groups);
  });
}

export function getFeatureProperty(name: string, defaultValue = null): (f: TiledMapFeatureData) => any {
  return (f: TiledMapFeatureData) => {
    return (f && f.properties && f.properties[name]) ? f.properties[name] : defaultValue;
  };
}

/**
 * return true if the given item belongs to at least one of the given groups
 */
export function itemInGroups(item: ITemplateItem, groups: string[]): boolean {
  if (!item) {
    return false;
  }
  // If there are no groups, the item is OK
  let groupsMatch: boolean = !item.groups || groups.length === 0;
  // If there are groups, make sure it matches at least one of them
  (item.groups || []).forEach((group: string) => {
    groupsMatch = groupsMatch || groups.indexOf(group) !== -1;
  });
  return groupsMatch;

}

/**
 * The categories of store (tied to definition of feature in TMX map
 */
export type StoreInventoryCategories = 'weapons' | 'armor' | 'items';

@Component({
  selector: 'store-feature',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['./store-feature.component.scss'],
  templateUrl: './store-feature.component.html'
})
export class StoreFeatureComponent extends TiledFeatureComponent implements OnDestroy {

  @Input() feature: TiledMapFeatureData;

  enter(object: TileObject): boolean {
    this.assertFeature();
    this.active = true;
    return true;
  }

  exit(object: TileObject): boolean {
    this.assertFeature();
    this.active = false;
    return true;
  }

  @Output() onClose = new EventEmitter();

  @Input() scene: IScene;

  /**
   * The name of this (fine) establishment.
   */
  name$: Observable<string> = this.feature$.map(getFeatureProperty('name'));

  /**
   * The item groups that this vendor sells
   */
  groups$: Observable<string[]> = this.feature$.map(getFeatureProperty('groups', []));

  /**
   * The category of store as determined by its map feature.
   * @type {ReplaySubject<StoreInventoryCategories>}
   */
  category$: Observable<StoreInventoryCategories> = this.feature$.map(getFeatureProperty('category'));

  private _active$ = new BehaviorSubject<boolean>(false);
  active$: Observable<boolean> = this._active$;

  @Input()
  set active(value: boolean) {
    this._active$.next(value);
  }
  /** @internal */
  private _level$: BehaviorSubject<number> = new BehaviorSubject<number>(1);
  /** @internal */
  private _weapons$: Observable<ITemplateWeapon[]> = this.store.select(getGameDataWeapons);
  /** @internal */
  private _armors$: Observable<ITemplateWeapon[]> = this.store.select(getGameDataArmors);
  /** @internal */
  private _items$: Observable<ITemplateWeapon[]> = this.store.select(getGameDataItems);
  /** @internal */
  private _selling$ = new BehaviorSubject<boolean>(false);

  /**
   * The amount of gold the party has to spend
   */
  partyGold$: Observable<number> = this.store.select(getGamePartyGold);

  /** The level of items available at this store */
  level$: Observable<number> = this._level$;

  /**
   * The items available for sale at this store.
   */
  partyInventory$: Observable<Item[]> = this.store.select(getGameInventory)
    .combineLatest(this.category$, (inventory, category) => {
      return inventory.filter((i) => i.category === category);
    })
    .combineLatest(this.groups$, sellItemsFilter);

  /**
   * Calculate the inventory for the store. Filter by category, item grouping, and player level.
   */
  inventory$: Observable<ITemplateItem[]> = this._weapons$
    .combineLatest(this._armors$, this._items$, this.category$, (weapons, armors, items, cat) => {
      switch (cat) {
        case 'items':
          return items;
        case 'weapons':
          return weapons;
        case 'armor':
          return armors;
        default:
          return [...items, ...weapons, ...armors];
      }
    })
    .combineLatest(this.groups$, this.level$, storeItemsFilter);

  /** Determine if the UI is in a selling state. */
  selling$: Observable<boolean> = this._selling$;

  /** @internal */
  _selected$ = new BehaviorSubject<Item>(null);
  /** The selected item to purchase/sell. */
  selected$: Observable<Item> = this._selected$;

  isBuying$: Observable<boolean> = Observable
    .combineLatest(this.selected$, this.selling$, (selected: boolean, selling: boolean) => {
      return !selected && !selling;
    });

  isSelling$: Observable<boolean> = Observable
    .combineLatest(this.selected$, this.selling$, (selected: boolean, selling: boolean) => {
      return !selected && selling;
    });

  /** Verb for the current buy/sell state for an action button */
  actionVerb$: Observable<string> = this.selling$.map((selling: boolean) => {
    return selling ? 'Sell' : 'Buy';
  });

  /** @internal */
  _onAction$ = new Subject<void>();
  /** @internal */
  _onToggleAction$ = new Subject<Item>();

  private _doToggleActionSubscription$ = this._onToggleAction$
    .throttleTime(500)
    .withLatestFrom(this.partyInventory$, (evt, inventory: Item[]) => {
      let selling = this._selling$.value;
      if (!selling) {
        if (inventory.length === 0) {
          this.notify.show("You don't have any inventory of this type to sell.", null, 1500);
          this._selling$.next(false);
          return;
        }
      }
      this._selling$.next(!selling);
    })
    .subscribe();

  /** Stream of clicks on the actionable button */
  private _doActionSubscription$ = this._onAction$
    .throttleTime(500)
    .switchMap(() => this.store.select(sliceGameState))
    .combineLatest(this.category$, (model: GameState, category: string) => {
      if (!this._selected$.value) {
        return;
      }
      const item = this._selected$.value;
      const isSelling = this._selling$.value;
      const value: number = item.value;
      if (!isSelling && value > model.gold) {
        this.notify.show("You don't have enough money");
        return;
      }

      this._selected$.next(null);
      this._selling$.next(false);

      if (isSelling) {
        this.notify.show(`Sold ${item.name} for ${item.value} gold.`, null, 1500);
        this.store.dispatch(new GameStateRemoveInventoryAction(item));
        this.store.dispatch(new EntityRemoveItemAction(item.eid));
        this.store.dispatch(new GameStateAddGoldAction(value));
      }
      else {
        const itemInstance = Immutable.fromJS(item).merge({
          eid: `${item.id}-${newGuid()}`,
          category
        }).toJS();
        this.notify.show(`Purchased ${item.name}.`, null, 1500);
        this.store.dispatch(new GameStateAddGoldAction(-value));
        this.store.dispatch(new EntityAddItemAction(itemInstance));
        this.store.dispatch(new GameStateAddInventoryAction(itemInstance));
      }

    }).subscribe();
  /** Stream of clicks on the actionable button */
  actionClick$: Observable<MouseEvent> = new Subject<MouseEvent>();

  constructor(public game: RPGGame,
              public notify: NotificationService,
              public store: Store<AppState>) {
    super();
  }

  ngOnDestroy(): void {
    this._doActionSubscription$.unsubscribe();
    this._doToggleActionSubscription$.unsubscribe();
  }
}
