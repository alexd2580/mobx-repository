import { observable, action } from "mobx";
import { RequestStatus, RequestState } from "./request-state";
import { Listener, ErrorListener } from "./listener";
import bind from "bind-decorator";

export abstract class BasicRepository<TModel, TId = string> {
    @observable protected entities = new Map<TId, TModel>();
    protected stateById = new RequestState();
    protected listenersById = new Map<TId, Listener[]>();
    protected errorListeners = new Set<ErrorListener>();

    protected abstract fetchById(id: TId): Promise<TModel>;

    protected abstract extractId(model: TModel): TId;

    @bind public byId(id: TId): TModel | undefined {
        this.loadById(id);
        return this.entities.get(id);
    }

    @bind public addErrorListener(listener: ErrorListener) {
        this.errorListeners.add(listener);
    }

    @bind public removeErrorListener(listener: ErrorListener) {
        this.errorListeners.delete(listener);
    }

    @bind public async byIdAsync(id: TId): Promise<TModel | undefined> {
        await this.loadById(id);
        return this.entities.get(id);
    }

    @bind public waitForId(id: TId): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.listenersById.has(id)) {
                this.listenersById.set(id, []);
            }
            this.listenersById.get(id)!.push({ resolve, reject });
        });
    }

    @bind public isLoaded(id: TId): boolean {
        return this.entities.has(id);
    }

    @bind public isKnown(id: TId): boolean {
        return this.stateById.isStatus(
            id,
            RequestStatus.ERROR,
            RequestStatus.IN_PROGRESS,
            RequestStatus.NOT_FOUND,
            RequestStatus.DONE,
        );
    }

    @action.bound public add(model: TModel): void {
        this.entities.set(this.extractId(model), model);
    }

    @action.bound public reset() {
        this.stateById.reset();
        this.listenersById.forEach(listeners => {
            listeners.forEach(({ reject }) => reject(new Error("Entity evicted while loading.")));
        });
        this.listenersById.clear();
        this.entities.clear();
    }

    @action.bound public evict(id: TId) {
        this.entities.delete(id);
        if (this.listenersById.has(id)) {
            this.listenersById.get(id)!.forEach(({ reject }) => reject(new Error("Entity evicted while loading.")));
            this.listenersById.delete(id);
        }
        this.stateById.delete(id);
    }

    @action.bound public async reloadId(id: TId): Promise<TModel> {
        this.evict(id);
        return await this.byIdAsync(id);
    }

    @action.bound private async loadById(id: TId) {
        if (this.stateById.isStatus(id, RequestStatus.DONE)) {
            return;
        }
        if (this.stateById.isStatus(id, RequestStatus.IN_PROGRESS, RequestStatus.ERROR)) {
            await this.waitForId(id);
            return;
        }
        this.stateById.setStatus(id, RequestStatus.IN_PROGRESS);
        try {
            const result = await this.fetchById(id);
            if (result === undefined) {
                this.stateById.setStatus(id, RequestStatus.NOT_FOUND);
                return;
            }
            if (this.extractId(result) !== id) {
                const error = new Error("Fetched entity has different id than requested.");
                this.errorListeners.forEach(callback => callback(error));
                throw error;
            }
            this.stateById.setStatus(id, RequestStatus.DONE);
            this.add(result);
            if (this.listenersById.has(id)) {
                this.listenersById.get(id)!.forEach(({ resolve }) => resolve());
            }
        } catch (error) {
            this.stateById.setStatus(id, RequestStatus.ERROR, error);
            this.errorListeners.forEach(callback => callback(error));
        }
    }
}