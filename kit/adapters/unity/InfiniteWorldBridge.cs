using UnityEngine;
using System.Runtime.InteropServices;
using System;

[Serializable] public class SavePlayer {
    public int hp = 3;
    public int max_hp = 3;
    public int sanity = 2;
    public int level = 1;
    public string status = "normal";
    public string[] curses = new string[0];
}
[Serializable] public class SaveItem {
    public string id;
    public string name;
    public string type;
    public bool relic;
    public int durability = -1;
}
[Serializable] public class CompletionReport {
    public CharacterSave save;
    public string[] acquiredItemIds;
}
[Serializable] public class TombstoneData {
    public int fallen_level;
    public string cause;
    public string epitaph;
}
[Serializable] public class CharacterSave {
    public string schema = "v3";
    public int level = 1;
    public string world;
    public SavePlayer player;
    public SaveItem[] items;
    public string[] clues;
    public string exit_hook;
    public string prev_world;
    public string next_world;
    public TombstoneData tombstone;
}

public class InfiniteWorldBridge : MonoBehaviour {
#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")] private static extern void IW_SendReady();
    [DllImport("__Internal")] private static extern void IW_CompleteLevel(string saveJson);
    [DllImport("__Internal")] private static extern void IW_CompleteWithItems(string reportJson);
    [DllImport("__Internal")] private static extern void IW_FailLevel(string reason, string saveJson);
#endif
    public CharacterSave CurrentSave;
    public event Action<CharacterSave> SaveLoaded;
    public event Action<string> HandoffCompleted;
    public event Action<string> HandoffFailed;

    void Start() {
#if UNITY_WEBGL && !UNITY_EDITOR
        IW_SendReady();
#else
        CurrentSave = new CharacterSave {
            world = "Unity测试世界",
            player = new SavePlayer(),
            items = new SaveItem[] { new SaveItem { id = "torch", name = "防风火把", type = "light" } },
            clues = new string[] { "列车将在5分钟后进站" },
            exit_hook = "跳上疾驰的列车", prev_world = "起点", next_world = "极夜车站"
        };
        SaveLoaded?.Invoke(CurrentSave);
#endif
    }

    public void OnSaveReceived(string json) {
        CurrentSave = JsonUtility.FromJson<CharacterSave>(json);
        SaveLoaded?.Invoke(CurrentSave);
    }

    public void OnHandoffResult(string json) {
        HandoffCompleted?.Invoke(json);
    }

    public void OnHandoffError(string message) {
        HandoffFailed?.Invoke(message);
    }

    public void FinishWithItemIds(string[] acquiredItemIds) {
        if (CurrentSave == null) throw new InvalidOperationException("尚未收到宿主存档");
        string json = JsonUtility.ToJson(new CompletionReport { save = CurrentSave, acquiredItemIds = acquiredItemIds });
#if UNITY_WEBGL && !UNITY_EDITOR
        IW_CompleteWithItems(json);
#else
        Debug.Log($"[Unity Offline Finish] {json}");
#endif
    }

    public void FinishLevel(string exitHook, SaveItem[] newItems, string[] newClues) {
        if (CurrentSave == null) throw new InvalidOperationException("尚未收到宿主存档");
        CurrentSave.exit_hook = exitHook;
        CurrentSave.items = newItems;
        CurrentSave.clues = newClues;
        string json = JsonUtility.ToJson(CurrentSave);
#if UNITY_WEBGL && !UNITY_EDITOR
        IW_CompleteLevel(json);
#else
        Debug.Log($"[Unity Offline Finish] {json}");
#endif
    }

    public void FailLevel(string reason = "力竭倒地") {
        if (CurrentSave == null) throw new InvalidOperationException("尚未收到宿主存档");
        string json = JsonUtility.ToJson(CurrentSave);
#if UNITY_WEBGL && !UNITY_EDITOR
        IW_FailLevel(reason, json);
#else
        Debug.Log($"[Unity Offline Fail] {reason}: {json}");
#endif
    }
}
