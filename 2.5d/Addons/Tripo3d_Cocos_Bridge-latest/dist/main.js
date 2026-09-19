"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
exports.load = load;
exports.unload = unload;
const package_json_1 = __importDefault(require("../package.json"));
const bridge_server_1 = require("./lib/bridge-server");
const state_1 = require("./lib/state");
const state = new state_1.BridgeState();
const server = new bridge_server_1.BridgeServer(state);
let pushTimer = null;
function pushStateToPanel() {
    if (pushTimer) {
        return;
    }
    pushTimer = setTimeout(() => {
        pushTimer = null;
        try {
            Editor.Message.send(package_json_1.default.name, 'state-changed', state.snapshot());
        }
        catch (_error) {
            // Panel may not be open — safe to ignore.
        }
    }, 100);
}
exports.methods = {
    openPanel() {
        Editor.Panel.open(package_json_1.default.name);
    },
    queryState() {
        return server.queryState();
    },
    startServer() {
        return server.start();
    },
    stopServer() {
        return server.stop();
    },
    clearLogs() {
        return server.clearLogs();
    },
};
function onAssetBroadcast() {
    server.notifyAssetEvent();
}
function load() {
    state.onChange = pushStateToPanel;
    Editor.Message.addBroadcastListener('asset-db:asset-add', onAssetBroadcast);
    Editor.Message.addBroadcastListener('asset-db:asset-change', onAssetBroadcast);
    state.addLog('Extension loaded.');
}
function unload() {
    state.onChange = null;
    Editor.Message.removeBroadcastListener('asset-db:asset-add', onAssetBroadcast);
    Editor.Message.removeBroadcastListener('asset-db:asset-change', onAssetBroadcast);
    if (pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
    }
    server.stop();
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7OztBQW1EQSxvQkFLQztBQUVELHdCQVdDO0FBckVELG1FQUEwQztBQUMxQyx1REFBbUQ7QUFDbkQsdUNBQTBDO0FBRTFDLE1BQU0sS0FBSyxHQUFHLElBQUksbUJBQVcsRUFBRSxDQUFDO0FBQ2hDLE1BQU0sTUFBTSxHQUFHLElBQUksNEJBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUV2QyxJQUFJLFNBQVMsR0FBMEIsSUFBSSxDQUFDO0FBRTVDLFNBQVMsZ0JBQWdCO0lBQ3ZCLElBQUksU0FBUyxFQUFFLENBQUM7UUFDZCxPQUFPO0lBQ1QsQ0FBQztJQUVELFNBQVMsR0FBRyxVQUFVLENBQUMsR0FBRyxFQUFFO1FBQzFCLFNBQVMsR0FBRyxJQUFJLENBQUM7UUFFakIsSUFBSSxDQUFDO1lBQ0gsTUFBTSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsc0JBQVcsQ0FBQyxJQUFJLEVBQUUsZUFBZSxFQUFFLEtBQUssQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDO1FBQzNFLENBQUM7UUFBQyxPQUFPLE1BQU0sRUFBRSxDQUFDO1lBQ2hCLDBDQUEwQztRQUM1QyxDQUFDO0lBQ0gsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQ1YsQ0FBQztBQUVZLFFBQUEsT0FBTyxHQUE0QztJQUM5RCxTQUFTO1FBQ1AsTUFBTSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsc0JBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN0QyxDQUFDO0lBRUQsVUFBVTtRQUNSLE9BQU8sTUFBTSxDQUFDLFVBQVUsRUFBRSxDQUFDO0lBQzdCLENBQUM7SUFFRCxXQUFXO1FBQ1QsT0FBTyxNQUFNLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDeEIsQ0FBQztJQUVELFVBQVU7UUFDUixPQUFPLE1BQU0sQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUN2QixDQUFDO0lBRUQsU0FBUztRQUNQLE9BQU8sTUFBTSxDQUFDLFNBQVMsRUFBRSxDQUFDO0lBQzVCLENBQUM7Q0FDRixDQUFDO0FBRUYsU0FBUyxnQkFBZ0I7SUFDdkIsTUFBTSxDQUFDLGdCQUFnQixFQUFFLENBQUM7QUFDNUIsQ0FBQztBQUVELFNBQWdCLElBQUk7SUFDbEIsS0FBSyxDQUFDLFFBQVEsR0FBRyxnQkFBZ0IsQ0FBQztJQUNqQyxNQUFNLENBQUMsT0FBZSxDQUFDLG9CQUFvQixDQUFDLG9CQUFvQixFQUFFLGdCQUFnQixDQUFDLENBQUM7SUFDcEYsTUFBTSxDQUFDLE9BQWUsQ0FBQyxvQkFBb0IsQ0FBQyx1QkFBdUIsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO0lBQ3hGLEtBQUssQ0FBQyxNQUFNLENBQUMsbUJBQW1CLENBQUMsQ0FBQztBQUNwQyxDQUFDO0FBRUQsU0FBZ0IsTUFBTTtJQUNwQixLQUFLLENBQUMsUUFBUSxHQUFHLElBQUksQ0FBQztJQUNyQixNQUFNLENBQUMsT0FBZSxDQUFDLHVCQUF1QixDQUFDLG9CQUFvQixFQUFFLGdCQUFnQixDQUFDLENBQUM7SUFDdkYsTUFBTSxDQUFDLE9BQWUsQ0FBQyx1QkFBdUIsQ0FBQyx1QkFBdUIsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO0lBRTNGLElBQUksU0FBUyxFQUFFLENBQUM7UUFDZCxZQUFZLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDeEIsU0FBUyxHQUFHLElBQUksQ0FBQztJQUNuQixDQUFDO0lBRUQsTUFBTSxDQUFDLElBQUksRUFBRSxDQUFDO0FBQ2hCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgcGFja2FnZUpTT04gZnJvbSAnLi4vcGFja2FnZS5qc29uJztcbmltcG9ydCB7IEJyaWRnZVNlcnZlciB9IGZyb20gJy4vbGliL2JyaWRnZS1zZXJ2ZXInO1xuaW1wb3J0IHsgQnJpZGdlU3RhdGUgfSBmcm9tICcuL2xpYi9zdGF0ZSc7XG5cbmNvbnN0IHN0YXRlID0gbmV3IEJyaWRnZVN0YXRlKCk7XG5jb25zdCBzZXJ2ZXIgPSBuZXcgQnJpZGdlU2VydmVyKHN0YXRlKTtcblxubGV0IHB1c2hUaW1lcjogTm9kZUpTLlRpbWVvdXQgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gcHVzaFN0YXRlVG9QYW5lbCgpIHtcbiAgaWYgKHB1c2hUaW1lcikge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHB1c2hUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIHB1c2hUaW1lciA9IG51bGw7XG5cbiAgICB0cnkge1xuICAgICAgRWRpdG9yLk1lc3NhZ2Uuc2VuZChwYWNrYWdlSlNPTi5uYW1lLCAnc3RhdGUtY2hhbmdlZCcsIHN0YXRlLnNuYXBzaG90KCkpO1xuICAgIH0gY2F0Y2ggKF9lcnJvcikge1xuICAgICAgLy8gUGFuZWwgbWF5IG5vdCBiZSBvcGVuIOKAlCBzYWZlIHRvIGlnbm9yZS5cbiAgICB9XG4gIH0sIDEwMCk7XG59XG5cbmV4cG9ydCBjb25zdCBtZXRob2RzOiBSZWNvcmQ8c3RyaW5nLCAoLi4uYXJnczogYW55W10pID0+IGFueT4gPSB7XG4gIG9wZW5QYW5lbCgpIHtcbiAgICBFZGl0b3IuUGFuZWwub3BlbihwYWNrYWdlSlNPTi5uYW1lKTtcbiAgfSxcblxuICBxdWVyeVN0YXRlKCkge1xuICAgIHJldHVybiBzZXJ2ZXIucXVlcnlTdGF0ZSgpO1xuICB9LFxuXG4gIHN0YXJ0U2VydmVyKCkge1xuICAgIHJldHVybiBzZXJ2ZXIuc3RhcnQoKTtcbiAgfSxcblxuICBzdG9wU2VydmVyKCkge1xuICAgIHJldHVybiBzZXJ2ZXIuc3RvcCgpO1xuICB9LFxuXG4gIGNsZWFyTG9ncygpIHtcbiAgICByZXR1cm4gc2VydmVyLmNsZWFyTG9ncygpO1xuICB9LFxufTtcblxuZnVuY3Rpb24gb25Bc3NldEJyb2FkY2FzdCgpIHtcbiAgc2VydmVyLm5vdGlmeUFzc2V0RXZlbnQoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxvYWQoKSB7XG4gIHN0YXRlLm9uQ2hhbmdlID0gcHVzaFN0YXRlVG9QYW5lbDtcbiAgKEVkaXRvci5NZXNzYWdlIGFzIGFueSkuYWRkQnJvYWRjYXN0TGlzdGVuZXIoJ2Fzc2V0LWRiOmFzc2V0LWFkZCcsIG9uQXNzZXRCcm9hZGNhc3QpO1xuICAoRWRpdG9yLk1lc3NhZ2UgYXMgYW55KS5hZGRCcm9hZGNhc3RMaXN0ZW5lcignYXNzZXQtZGI6YXNzZXQtY2hhbmdlJywgb25Bc3NldEJyb2FkY2FzdCk7XG4gIHN0YXRlLmFkZExvZygnRXh0ZW5zaW9uIGxvYWRlZC4nKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVubG9hZCgpIHtcbiAgc3RhdGUub25DaGFuZ2UgPSBudWxsO1xuICAoRWRpdG9yLk1lc3NhZ2UgYXMgYW55KS5yZW1vdmVCcm9hZGNhc3RMaXN0ZW5lcignYXNzZXQtZGI6YXNzZXQtYWRkJywgb25Bc3NldEJyb2FkY2FzdCk7XG4gIChFZGl0b3IuTWVzc2FnZSBhcyBhbnkpLnJlbW92ZUJyb2FkY2FzdExpc3RlbmVyKCdhc3NldC1kYjphc3NldC1jaGFuZ2UnLCBvbkFzc2V0QnJvYWRjYXN0KTtcblxuICBpZiAocHVzaFRpbWVyKSB7XG4gICAgY2xlYXJUaW1lb3V0KHB1c2hUaW1lcik7XG4gICAgcHVzaFRpbWVyID0gbnVsbDtcbiAgfVxuXG4gIHNlcnZlci5zdG9wKCk7XG59Il19