# Godot 4.x：作为 Autoload 单例加载，节点名保持 InfiniteWorldBridge。
extends Node

signal save_loaded(save_data: Dictionary)
signal handoff_result(receipt: Dictionary)
signal handoff_error(message: String)

var current_save: Dictionary = {}
var save_callback: JavaScriptObject
var handoff_callback: JavaScriptObject
var error_callback: JavaScriptObject

func _ready() -> void:
	if OS.has_feature("web"):
		save_callback = JavaScriptBridge.create_callback(_on_js_save_received)
		JavaScriptBridge.get_interface("window").iw_receive_save = save_callback
		handoff_callback = JavaScriptBridge.create_callback(_on_js_handoff_result)
		JavaScriptBridge.get_interface("window").iw_handoff_result = handoff_callback
		error_callback = JavaScriptBridge.create_callback(_on_js_handoff_error)
		JavaScriptBridge.get_interface("window").iw_handoff_error = error_callback
		JavaScriptBridge.eval("""
			if (window.WL && typeof window.WL.ready === 'function' && window.parent !== window) {
				window.WL.ready().then(function (save) {
					if (window.iw_receive_save) window.iw_receive_save(JSON.stringify(save));
				}).catch(function (error) {
					if (window.iw_handoff_error) window.iw_handoff_error(String(error && error.message || error));
				});
			} else {
				if (!window.__iw_godot_listener) {
					window.__iw_godot_listener = true;
					window.addEventListener('message', function (e) {
						if (e.source === window.parent && e.data && e.data.save && (e.data.type === 'IW_INIT_SAVE' || e.data.type === 'iw-init')) {
							if (window.iw_receive_save) window.iw_receive_save(JSON.stringify(e.data.save));
						}
					});
				}
				if (window.parent !== window) {
					window.parent.postMessage({ type: 'IW_READY' }, '*');
				} else if (window.WL) {
					window.iw_receive_save(JSON.stringify(window.WL.readSave()));
				}
			}
		""")
	else:
		_on_js_save_received([JSON.stringify({
			"schema": "v3", "level": 1, "world": "本地测试世界",
			"player": {"hp": 3, "max_hp": 3, "sanity": 2, "level": 1, "status": "normal", "curses": []},
			"items": [{"id": "test_lamp", "name": "便携提灯", "type": "light", "relic": false}],
			"clues": ["这是一条测试线索"], "exit_hook": "测试出口",
			"prev_world": "起点", "next_world": "终点", "tombstone": {}
		})])

func _on_js_save_received(args: Array) -> void:
	var json = JSON.new()
	if not args.is_empty() and json.parse(String(args[0])) == OK and json.data is Dictionary:
		current_save = json.data
		save_loaded.emit(current_save)

func _on_js_handoff_result(args: Array) -> void:
	var json = JSON.new()
	if not args.is_empty() and json.parse(String(args[0])) == OK and json.data is Dictionary:
		handoff_result.emit(json.data)

func _on_js_handoff_error(args: Array) -> void:
	handoff_error.emit(String(args[0]) if not args.is_empty() else "交接失败")

func complete_with_item_ids(acquired_item_ids: Array[String]) -> void:
	if OS.has_feature("web"):
		var report_json = JSON.stringify(JSON.stringify({"save": current_save, "acquiredItemIds": acquired_item_ids}))
		JavaScriptBridge.eval("""
			const report = JSON.parse(%s);
			if (window.WL && typeof window.WL.complete === 'function') {
				window.WL.complete(report.save, { acquiredItemIds: report.acquiredItemIds })
					.then(function (receipt) { if (window.iw_handoff_result) window.iw_handoff_result(JSON.stringify(receipt)); })
					.catch(function (error) { if (window.iw_handoff_error) window.iw_handoff_error(String(error && error.message || error)); });
			} else if (window.WL && window.WL.completeLevel) {
				window.WL.completeLevel(window.CONFIG || {}, report.save, { acquiredItemIds: report.acquiredItemIds });
			} else if (window.parent !== window) {
				window.parent.postMessage({ type: 'IW_SAVE', save: report.save, acquiredItemIds: report.acquiredItemIds }, '*');
			}
		""" % report_json)
	else:
		print("[Offline Complete IDs] ", acquired_item_ids)

func complete_level(exit_hook: String, new_items: Array, new_clues: Array) -> void:
	current_save["exit_hook"] = exit_hook
	current_save["items"] = new_items
	current_save["clues"] = new_clues
	if OS.has_feature("web"):
		var save_json = JSON.stringify(JSON.stringify(current_save))
		JavaScriptBridge.eval("""
			const save = JSON.parse(%s);
			if (window.WL && window.WL.completeLevel) {
				window.WL.completeLevel(window.CONFIG || {}, save, {
					exitHook: save.exit_hook,
					nextUrl: (window.CONFIG || {}).nextUrl || window.location.href
				});
			} else if (window.parent !== window) {
				window.parent.postMessage({ type: 'IW_SAVE', save: save }, '*');
			}
		""" % save_json)
	else:
		print("[Offline Complete] ", current_save)

func fail_level(reason: String = "力竭倒地") -> void:
	if OS.has_feature("web"):
		var save_json = JSON.stringify(JSON.stringify(current_save))
		JavaScriptBridge.eval("""
			const save = JSON.parse(%s);
			const reason = %s;
			if (window.WL && typeof window.WL.fail === 'function') {
				window.WL.fail(reason, save, { acquiredItemIds: [] })
					.then(function (receipt) { if (window.iw_handoff_result) window.iw_handoff_result(JSON.stringify(receipt)); })
					.catch(function (error) { if (window.iw_handoff_error) window.iw_handoff_error(String(error && error.message || error)); });
			} else if (window.WL && window.WL.failLevel) {
				window.WL.failLevel(reason, save, window.CONFIG || {});
			} else if (window.parent !== window) {
				window.parent.postMessage({ type: 'IW_FAIL', reason: reason, fallenSave: save }, '*');
			}
		""" % [save_json, JSON.stringify(reason)])
	else:
		print("[Offline Fail] ", reason)
