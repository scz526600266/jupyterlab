// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { IStateDB } from '@jupyterlab/coreutils';

import { ArrayExt, each, find } from '@phosphor/algorithm';

import { CommandRegistry } from '@phosphor/commands';

import { PromiseDelegate, ReadonlyJSONObject } from '@phosphor/coreutils';

import { IDisposable } from '@phosphor/disposable';

import { AttachedProperty } from '@phosphor/properties';

import { ISignal, Signal } from '@phosphor/signaling';

import { FocusTracker, Widget } from '@phosphor/widgets';

interface IObservableDisposable extends IDisposable {
  disposed: ISignal<any, void>;
}

/**
 * An object that tracks instances of a generic objects.
 */
export interface IInstanceTracker<T extends IObservableDisposable>
  extends IDisposable {
  /**
   * A signal emitted when an instance is added.
   *
   * #### Notes
   * This signal will only fire when an instance is added to the tracker.
   * It will not fire if an instance is injected into the tracker.
   */
  readonly added: ISignal<this, T>;

  /**
   * The current instance is the most recently focused or added instance.
   *
   * #### Notes
   * It is the most recently focused widget, or the most recently added
   * widget if no widget has taken focus.
   */
  readonly current: T | null;

  /**
   * A signal emitted when the current instance changes.
   *
   * #### Notes
   * If the last instance being tracked is disposed, `null` will be emitted.
   */
  readonly currentChanged: ISignal<this, T | null>;

  /**
   * The number of instances held by the tracker.
   */
  readonly size: number;

  /**
   * A promise that is resolved when the instance tracker has been
   * restored from a serialized state.
   *
   * #### Notes
   * Most client code will not need to use this, since they can wait
   * for the whole application to restore. However, if an extension
   * wants to perform actions during the application restoration, but
   * after the restoration of another instance tracker, they can use
   * this promise.
   */
  readonly restored: Promise<void>;

  /**
   * A signal emitted when an instance is updated.
   */
  readonly updated: ISignal<this, T>;

  /**
   * Find the first instance in the tracker that satisfies a filter function.
   *
   * @param - fn The filter function to call on each instance.
   *
   * #### Notes
   * If nothing is found, the value returned is `undefined`.
   */
  find(fn: (obj: T) => boolean): T | undefined;

  /**
   * Iterate through each instance in the tracker.
   *
   * @param fn - The function to call on each instance.
   */
  forEach(fn: (obj: T) => void): void;

  /**
   * Filter the instances in the tracker based on a predicate.
   *
   * @param fn - The function by which to filter.
   */
  filter(fn: (obj: T) => boolean): T[];

  /**
   * Check if this tracker has the specified instance.
   *
   * @param obj - The object whose existence is being checked.
   */
  has(obj: T): boolean;

  /**
   * Inject an instance into the instance tracker without the tracker handling
   * its restoration lifecycle.
   *
   * @param obj - The instance to inject into the tracker.
   */
  inject(obj: T): void;
}

/**
 * A class that keeps track of widget instances on an Application shell.
 */
export class InstanceTracker<T extends IObservableDisposable>
  implements IInstanceTracker<T> {
  /**
   * Create a new instance tracker.
   *
   * @param options - The instantiation options for an instance tracker.
   */
  constructor(options: InstanceTracker.IOptions) {
    this.namespace = options.namespace;
  }

  /**
   * A signal emitted when an object instance is added.
   *
   * #### Notes
   * This signal will only fire when an instance is added to the tracker.
   * It will not fire if an instance injected into the tracker.
   */
  get added(): ISignal<this, T> {
    return this._added;
  }

  /**
   * A namespace for all tracked instances.
   */
  readonly namespace: string;

  /**
   * The current instance.
   */
  get current(): T | null {
    return this._current;
  }
  set current(obj: T) {
    if (this._current === obj) {
      return;
    }
    this._current = obj;
    this.onCurrentChanged(this._current);
    this._currentChanged.emit(this._current);
  }

  /**
   * A signal emitted when the current widget changes.
   */
  get currentChanged(): ISignal<this, T | null> {
    return this._currentChanged;
  }

  /**
   * A promise resolved when the instance tracker has been restored.
   */
  get restored(): Promise<void> {
    return this._restored.promise;
  }

  /**
   * The number of instances held by the tracker.
   */
  get size(): number {
    return this._instances.size;
  }

  /**
   * A signal emitted when an instance is updated.
   */
  get updated(): ISignal<this, T> {
    return this._updated;
  }

  /**
   * Add a new instance to the tracker.
   *
   * @param obj - The object instance being added.
   */
  async add(obj: T): Promise<void> {
    if (obj.isDisposed) {
      const warning = 'A disposed object cannot be added.';
      console.warn(warning, obj);
      throw new Error(warning);
    }

    if (this._instances.has(obj)) {
      const warning = 'This object already exists in the tracker.';
      console.warn(warning, obj);
      throw new Error(warning);
    }

    this._instances.add(obj);

    if (Private.injectedProperty.get(obj)) {
      return;
    }

    // Handle instance being disposed.
    obj.disposed.connect(this._onInstanceDisposed, this);

    // Handle instance state restoration.
    if (this._restore) {
      const { state } = this._restore;
      const objName = this._restore.name(obj);

      if (objName) {
        const name = `${this.namespace}:${objName}`;
        const data = this._restore.args(obj);

        Private.nameProperty.set(obj, name);
        await state.save(name, { data });
      }
    }

    // If there is no current instance, set this as the current instance.
    if (this.current === null) {
      this.current = obj;
    }

    // Emit the added signal.
    this._added.emit(obj);
  }

  /**
   * Test whether the tracker is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Dispose of the resources held by the tracker.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._current = null;
    this._instances.clear();
    this._isDisposed = true;
    Signal.clearData(this);
  }

  /**
   * Find the first instance in the tracker that satisfies a filter function.
   *
   * @param - fn The filter function to call on each instance.
   */
  find(fn: (obj: T) => boolean): T | undefined {
    const values = this._instances.values();
    for (let value of values) {
      if (fn(value)) {
        return value;
      }
    }
    return undefined;
  }

  /**
   * Iterate through each instance in the tracker.
   *
   * @param fn - The function to call on each instance.
   */
  forEach(fn: (obj: T) => void): void {
    this._instances.forEach(fn);
  }

  /**
   * Filter the instances in the tracker based on a predicate.
   *
   * @param fn - The function by which to filter.
   */
  filter(fn: (obj: T) => boolean): T[] {
    const filtered: T[] = [];
    this.forEach(obj => {
      if (fn(obj)) {
        filtered.push(obj);
      }
    });
    return filtered;
  }

  /**
   * Inject an instance into the instance tracker without the tracker handling
   * its restoration lifecycle.
   *
   * @param obj - The instance to inject into the tracker.
   */
  inject(obj: T): Promise<void> {
    Private.injectedProperty.set(obj, true);
    return this.add(obj);
  }

  /**
   * Check if this tracker has the specified instance.
   *
   * @param obj - The object whose existence is being checked.
   */
  has(obj: T): boolean {
    return this._instances.has(obj);
  }

  /**
   * Restore the instances in this tracker's namespace.
   *
   * @param options - The configuration options that describe restoration.
   *
   * @returns A promise that resolves when restoration has completed.
   *
   * #### Notes
   * This function should almost never be invoked by client code. Its primary
   * use case is to be invoked by a layout restorer plugin that handles
   * multiple instance trackers and, when ready, asks them each to restore their
   * respective instances.
   */
  async restore(options: InstanceTracker.IRestoreOptions<T>): Promise<any> {
    if (this._hasRestored) {
      throw new Error('Instance tracker has already restored');
    }

    this._hasRestored = true;

    const { command, registry, state, when } = options;
    const namespace = this.namespace;
    const promises = when
      ? [state.list(namespace)].concat(when)
      : [state.list(namespace)];

    this._restore = options;

    const [saved] = await Promise.all(promises);
    const values = await Promise.all(
      saved.ids.map((id, index) => {
        const value = saved.values[index];
        const args = value && (value as any).data;

        if (args === undefined) {
          return state.remove(id);
        }

        // Execute the command and if it fails, delete the state restore data.
        return registry.execute(command, args).catch(() => state.remove(id));
      })
    );
    this._restored.resolve();
    return values;
  }

  /**
   * Save the restore data for a given instance.
   *
   * @param obj - The instance being saved.
   */
  async save(obj: T): Promise<void> {
    const injected = Private.injectedProperty.get(obj);

    if (!this._restore || !this.has(obj) || injected) {
      return;
    }

    const { state } = this._restore;
    const objName = this._restore.name(obj);
    const oldName = Private.nameProperty.get(obj);
    const newName = objName ? `${this.namespace}:${objName}` : '';

    if (oldName && oldName !== newName) {
      await state.remove(oldName);
    }

    // Set the name property irrespective of whether the new name is null.
    Private.nameProperty.set(obj, newName);

    if (newName) {
      const data = this._restore.args(obj);
      await state.save(newName, { data });
    }

    if (oldName !== newName) {
      this._updated.emit(obj);
    }
  }

  /**
   * Handle the current change event.
   *
   * #### Notes
   * The default implementation is a no-op.
   */
  protected onCurrentChanged(value: T | null): void {
    /* no-op */
  }

  /**
   * Clean up after disposed instances.
   */
  private _onInstanceDisposed(obj: T): void {
    // Handle widget removal.
    this._instances.delete(obj);

    if (Private.injectedProperty.get(obj)) {
      return;
    }

    // Handle the current instance being disposed.
    if (obj === this._current) {
      this._current = null;
      this.onCurrentChanged(this._current);
      this._currentChanged.emit(this._current);
    }

    // If there is no restore data, return.
    if (!this._restore) {
      return;
    }

    const { state } = this._restore;
    const name = Private.nameProperty.get(obj);

    if (name) {
      void state.remove(name);
    }
  }

  private _added = new Signal<this, T>(this);
  private _current: T | null = null;
  private _currentChanged = new Signal<this, T | null>(this);
  private _hasRestored = false;
  private _instances = new Set<T>();
  private _isDisposed = false;
  private _restore: InstanceTracker.IRestoreOptions<T> | null = null;
  private _restored = new PromiseDelegate<void>();
  private _updated = new Signal<this, T>(this);
}

/**
 * A namespace for `InstanceTracker` statics.
 */
export namespace InstanceTracker {
  /**
   * The instantiation options for an instance tracker.
   */
  export interface IOptions {
    /**
     * A namespace for all tracked widgets, (e.g., `notebook`).
     */
    namespace: string;
  }

  /**
   * The state restoration configuration options.
   */
  export interface IRestoreOptions<T extends IObservableDisposable> {
    /**
     * The command to execute when restoring instances.
     */
    command: string;

    /**
     * A function that returns the args needed to restore an instance.
     */
    args: (widget: T) => ReadonlyJSONObject;

    /**
     * A function that returns a unique persistent name for this instance.
     */
    name: (widget: T) => string;

    /**
     * The command registry which holds the restore command.
     */
    registry: CommandRegistry;

    /**
     * The state database instance.
     */
    state: IStateDB;

    /**
     * The point after which it is safe to restore state.
     *
     * #### Notes
     * By definition, this promise or promises will happen after the application
     * has `started`.
     */
    when?: Promise<any> | Array<Promise<any>>;
  }
}

/**
 * A class that keeps track of widget instances on an Application shell.
 *
 * #### Notes
 * The API surface area of this concrete implementation is substantially larger
 * than the instance tracker interface it implements. The interface is intended
 * for export by JupyterLab plugins that create widgets and have clients who may
 * wish to keep track of newly created widgets. This class, however, can be used
 * internally by plugins to restore state as well.
 */
export class WidgetTracker<T extends Widget = Widget> {
  /**
   * Create a new instance tracker.
   *
   * @param options - The instantiation options for an instance tracker.
   */
  constructor(options: InstanceTracker.IOptions) {
    this.namespace = options.namespace;
    this._tracker.currentChanged.connect(this._onCurrentChanged, this);
  }

  /**
   * A signal emitted when the current widget changes.
   */
  get currentChanged(): ISignal<this, T | null> {
    return this._currentChanged;
  }

  /**
   * A signal emitted when a widget is added.
   *
   * #### Notes
   * This signal will only fire when a widget is added to the tracker. It will
   * not fire if a widget is injected into the tracker.
   */
  get widgetAdded(): ISignal<this, T> {
    return this._widgetAdded;
  }

  /**
   * A signal emitted when a widget is updated.
   */
  get widgetUpdated(): ISignal<this, T> {
    return this._widgetUpdated;
  }

  /**
   * A namespace for all tracked widgets, (e.g., `notebook`).
   */
  readonly namespace: string;

  /**
   * The current widget is the most recently focused or added widget.
   *
   * #### Notes
   * It is the most recently focused widget, or the most recently added
   * widget if no widget has taken focus.
   */
  get currentWidget(): T | null {
    return this._currentWidget;
  }

  /**
   * A promise resolved when the instance tracker has been restored.
   */
  get restored(): Promise<void> {
    return this._restored.promise;
  }

  /**
   * The number of widgets held by the tracker.
   */
  get size(): number {
    return this._tracker.widgets.length;
  }

  /**
   * Add a new widget to the tracker.
   *
   * @param widget - The widget being added.
   *
   * #### Notes
   * When a widget is added its state is saved to the state database.
   * This function returns a promise that is resolved when that saving
   * is completed. However, the widget is added to the in-memory tracker
   * synchronously, and is available to use before the promise is resolved.
   */
  add(widget: T): Promise<void> {
    if (widget.isDisposed) {
      const warning = `${widget.id} is disposed and cannot be tracked.`;
      console.warn(warning);
      return Promise.reject(warning);
    }
    if (this._tracker.has(widget)) {
      const warning = `${widget.id} already exists in the tracker.`;
      console.warn(warning);
      return Promise.reject(warning);
    }
    this._tracker.add(widget);
    this._widgets.push(widget);

    let injected = Private.injectedProperty.get(widget);
    let promise: Promise<void> = Promise.resolve(void 0);

    if (injected) {
      return promise;
    }

    widget.disposed.connect(this._onWidgetDisposed, this);

    // Handle widget state restoration.
    if (this._restore) {
      let { state } = this._restore;
      let widgetName = this._restore.name(widget);

      if (widgetName) {
        let name = `${this.namespace}:${widgetName}`;
        let data = this._restore.args(widget);

        Private.nameProperty.set(widget, name);
        promise = state.save(name, { data });
      }
    }

    // If there is no focused widget, set this as the current widget.
    if (!this._tracker.currentWidget) {
      this._currentWidget = widget;
      this.onCurrentChanged(widget);
      this._currentChanged.emit(widget);
    }

    // Emit the widget added signal.
    this._widgetAdded.emit(widget);

    return promise;
  }

  /**
   * Test whether the tracker is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Dispose of the resources held by the tracker.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._isDisposed = true;
    Signal.clearData(this);
    this._tracker.dispose();
  }

  /**
   * Find the first widget in the tracker that satisfies a filter function.
   *
   * @param - fn The filter function to call on each widget.
   *
   * #### Notes
   * If no widget is found, the value returned is `undefined`.
   */
  find(fn: (widget: T) => boolean): T | undefined {
    return find(this._tracker.widgets, fn);
  }

  /**
   * Iterate through each widget in the tracker.
   *
   * @param fn - The function to call on each widget.
   */
  forEach(fn: (widget: T) => void): void {
    each(this._tracker.widgets, widget => {
      fn(widget);
    });
  }

  /**
   * Filter the widgets in the tracker based on a predicate.
   *
   * @param fn - The function by which to filter.
   */
  filter(fn: (widget: T) => boolean): T[] {
    return this._tracker.widgets.filter(fn);
  }

  /**
   * Inject a foreign widget into the instance tracker.
   *
   * @param widget - The widget to inject into the tracker.
   *
   * #### Notes
   * Any widgets injected into an instance tracker will not have their state
   * saved by the tracker. The primary use case for widget injection is for a
   * plugin that offers a sub-class of an extant plugin to have its instances
   * share the same commands as the parent plugin (since most relevant commands
   * will use the `currentWidget` of the parent plugin's instance tracker). In
   * this situation, the sub-class plugin may well have its own instance tracker
   * for layout and state restoration in addition to injecting its widgets into
   * the parent plugin's instance tracker.
   */
  inject(widget: T): void {
    Private.injectedProperty.set(widget, true);
    void this.add(widget);
  }

  /**
   * Check if this tracker has the specified widget.
   *
   * @param widget - The widget whose existence is being checked.
   */
  has(widget: Widget): boolean {
    return this._tracker.has(widget as any);
  }

  /**
   * Restore the widgets in this tracker's namespace.
   *
   * @param options - The configuration options that describe restoration.
   *
   * @returns A promise that resolves when restoration has completed.
   *
   * #### Notes
   * This function should almost never be invoked by client code. Its primary
   * use case is to be invoked by a layout restorer plugin that handles
   * multiple instance trackers and, when ready, asks them each to restore their
   * respective widgets.
   */
  async restore(options: InstanceTracker.IRestoreOptions<T>): Promise<any> {
    if (this._hasRestored) {
      throw new Error('Instance tracker has already restored');
    }
    this._hasRestored = true;
    const { command, registry, state, when } = options;
    const namespace = this.namespace;
    const promises = when
      ? [state.list(namespace)].concat(when)
      : [state.list(namespace)];

    this._restore = options;

    const [saved] = await Promise.all(promises);
    const values = await Promise.all(
      saved.ids.map((id, index) => {
        const value = saved.values[index];
        const args = value && (value as any).data;
        if (args === undefined) {
          return state.remove(id);
        }

        // Execute the command and if it fails, delete the state restore data.
        return registry.execute(command, args).catch(() => state.remove(id));
      })
    );
    this._restored.resolve(undefined);
    return values;
  }

  /**
   * Save the restore data for a given widget.
   *
   * @param widget - The widget being saved.
   */
  async save(widget: T): Promise<void> {
    const injected = Private.injectedProperty.get(widget);

    if (!this._restore || !this.has(widget) || injected) {
      return;
    }

    const { state } = this._restore;
    const widgetName = this._restore.name(widget);
    const oldName = Private.nameProperty.get(widget);
    const newName = widgetName ? `${this.namespace}:${widgetName}` : '';

    if (oldName && oldName !== newName) {
      await state.remove(oldName);
    }

    // Set the name property irrespective of whether the new name is null.
    Private.nameProperty.set(widget, newName);

    if (newName) {
      const data = this._restore.args(widget);
      await state.save(newName, { data });
    }

    if (oldName !== newName) {
      this._widgetUpdated.emit(widget);
    }
  }

  /**
   * Handle the current change event.
   *
   * #### Notes
   * The default implementation is a no-op.
   */
  protected onCurrentChanged(value: T | null): void {
    /* no-op */
  }

  /**
   * Handle the current change signal from the internal focus tracker.
   */
  private _onCurrentChanged(
    sender: any,
    args: FocusTracker.IChangedArgs<T>
  ): void {
    // Bail if the active widget did not change.
    if (args.newValue === this._currentWidget) {
      return;
    }

    this._currentWidget = args.newValue;
    this.onCurrentChanged(args.newValue);
    this._currentChanged.emit(args.newValue);
  }

  /**
   * Clean up after disposed widgets.
   */
  private _onWidgetDisposed(widget: T): void {
    const injected = Private.injectedProperty.get(widget);

    if (injected) {
      return;
    }

    // Handle widget removal.
    ArrayExt.removeFirstOf(this._widgets, widget);

    // Handle the current widget being disposed.
    if (widget === this._currentWidget) {
      this._currentWidget =
        this._tracker.currentWidget ||
        this._widgets[this._widgets.length - 1] ||
        null;
      this.onCurrentChanged(this._currentWidget);
      this._currentChanged.emit(this._currentWidget);
    }

    // If there is no restore data, return.
    if (!this._restore) {
      return;
    }

    const { state } = this._restore;
    const name = Private.nameProperty.get(widget);

    if (name) {
      void state.remove(name);
    }
  }

  private _hasRestored = false;
  private _restore: InstanceTracker.IRestoreOptions<T> | null = null;
  private _restored = new PromiseDelegate<void>();
  private _tracker = new FocusTracker<T>();
  private _currentChanged = new Signal<this, T | null>(this);
  private _widgetAdded = new Signal<this, T>(this);
  private _widgetUpdated = new Signal<this, T>(this);
  private _widgets: T[] = [];
  private _currentWidget: T | null = null;
  private _isDisposed = false;
}

/*
 * A namespace for private data.
 */
namespace Private {
  /**
   * An attached property to indicate whether an instance has been injected.
   */
  export const injectedProperty = new AttachedProperty<
    IObservableDisposable,
    boolean
  >({
    name: 'injected',
    create: () => false
  });

  /**
   * An attached property for an instance's ID.
   */
  export const nameProperty = new AttachedProperty<
    IObservableDisposable,
    string
  >({
    name: 'name',
    create: () => ''
  });
}
